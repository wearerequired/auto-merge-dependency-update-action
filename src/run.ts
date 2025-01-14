import * as core from '@actions/core';
import * as github from '@actions/github';
import { PullRequestEvent } from '@octokit/webhooks-definitions/schema';
import { components } from '@octokit/openapi-types';
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils';
import { throttling } from '@octokit/plugin-throttling';
import { detailedDiff } from 'deep-object-diff';
import semver from 'semver';
import { Result } from './result';

const semverRegex = /^([~^]?)[0-9]+\.[0-9]+\.[0-9]+(-.+)?$/;

export async function run(): Promise<Result> {
	const startTime = Date.now();
	core.info('Starting');

	const context = github.context;
	core.debug(JSON.stringify(context, null, 2));

	if (!['pull_request', 'pull_request_target'].includes(github.context.eventName)) {
		core.error(`Unsupported event name: ${github.context.eventName}`);
		return Result.UnknownEvent;
	}

	const token = core.getInput('github-token', { required: true });

	const mergeMethod = core.getInput('merge-method').toUpperCase();
	if (!['SQUASH', 'MERGE', 'REBASE'].includes(mergeMethod)) {
		core.error(`Merge method not allowed: ${mergeMethod}`);
		return Result.UnknownMergeMethod;
	}

	const mergeAuthorEmail = core.getInput('merge-author-email') || null;

	const allowedActors = core
		.getInput('allowed-actors', { required: true })
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);

	const allowedUpdateTypes: Record<string, string[]> = {};
	core.getInput('allowed-update-types', { required: true })
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean)
		.forEach((group) => {
			const parts = group
				.trim()
				.split(':', 2)
				.map((a) => a.trim());
			if (parts.length !== 2 || !parts.every((a) => typeof a === 'string')) {
				throw new Error('allowed-update-types invalid');
			}
			const [dependencyType, bumpType] = parts;
			if (!allowedUpdateTypes[dependencyType]) {
				allowedUpdateTypes[dependencyType] = [];
			}
			allowedUpdateTypes[dependencyType].push(bumpType);
		});

	const packageBlockList = (core.getInput('package-block-list') || '')
		.split(',')
		.map((a) => a.trim());

	if (!allowedActors.includes(context.actor)) {
		core.error(`Actor not allowed: ${context.actor}`);
		return Result.ActorNotAllowed;
	}

	const payload: PullRequestEvent = github.context.payload as any;
	const pr = payload.pull_request;

	const Octokit = GitHub.plugin(throttling);
	const octokit = new Octokit(
		getOctokitOptions(token, {
			throttle: {
				onRateLimit: /* istanbul ignore next */ (retryAfter: number) => {
					core.warning(`Hit rate limit. Retrying in ${retryAfter} seconds`);
					return true;
				},
				onAbuseLimit: /* istanbul ignore next */ (retryAfter: number) => {
					core.warning(`Hit abuse limit. Retrying in ${retryAfter} seconds`);
					return true;
				},
			},
		})
	);

	const readPackageJson = async (ref: string): Promise<Record<string, any>> => {
		const { data } = await octokit.rest.repos.getContent({
			owner: context.repo.owner,
			repo: context.repo.repo,
			path: 'package.json',
			ref,
		});
		if (
			Array.isArray(data) ||
			data.type !== 'file' ||
			(data as components['schemas']['content-file']).encoding !== 'base64'
		) {
			throw new Error('Unexpected repo content response');
		}
		return JSON.parse(
			Buffer.from((data as components['schemas']['content-file']).content, 'base64').toString(
				'utf-8'
			)
		);
	};

	const enableAutoMerge = async (): Promise<Result.Success | Result.PRNotOpen> => {
		const prData = await getPR();
		if (prData.data.state !== 'open') {
			core.error('PR is not open');
			return Result.PRNotOpen;
		}

		const mutation = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod, $authorEmail: String) {
	enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, authorEmail: $authorEmail}) {
		pullRequest {
			autoMergeRequest {
				enabledAt
			}
		}
	}
}`;
		const variables = {
			pullRequestId: pr.node_id,
			mergeMethod: mergeMethod,
			authorEmail: mergeAuthorEmail,
		};
		const result: any = await octokit.graphql(mutation, variables);
		if (!result?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt) {
			core.debug(JSON.stringify(result, null, 2));
			throw new Error('Failed to enable auto-merge');
		}

		core.info('Auto-merge enabled');
		return Result.Success;
	};

	const getCommit = () =>
		octokit.rest.repos.getCommit({
			owner: context.repo.owner,
			repo: context.repo.repo,
			ref: pr.head.sha,
		});

	const getPR = () =>
		octokit.rest.pulls.get({
			owner: context.repo.owner,
			repo: context.repo.repo,
			pull_number: pr.number,
		});

	const validVersionChange = (
		oldVersion: string,
		newVersion: string,
		allowedBumpTypes: string[]
	): boolean => {
		const oldVersionMatches = semverRegex.exec(oldVersion);
		if (!oldVersionMatches) {
			return false;
		}
		const newVersionMatches = semverRegex.exec(newVersion);
		if (!newVersionMatches) {
			return false;
		}
		const oldVersionPrefix = oldVersionMatches[1];
		const newVersionPrefix = newVersionMatches[1];
		if (oldVersionPrefix !== newVersionPrefix) {
			return false;
		}

		const oldVersionExact = oldVersion.slice(oldVersionPrefix.length);
		const newVersionExact = newVersion.slice(newVersionPrefix.length);

		if (semver.gte(oldVersionExact, newVersionExact)) {
			return false;
		}

		const allowed: Array<string | null> = [];
		if (allowedBumpTypes.includes('major')) {
			allowed.push('major');
		}
		if (allowedBumpTypes.includes('minor')) {
			allowed.push('minor');
		}
		if (allowedBumpTypes.includes('patch')) {
			allowed.push('patch');
		}
		return allowed.includes(semver.diff(oldVersionExact, newVersionExact));
	};

	core.info('Getting commit info');
	const commit = await getCommit();
	if (!commit.data.files) {
		core.error('Could not find any changed files');
		return Result.NoChanges;
	}
	const onlyPackageJsonChanged = commit.data.files.every(
		({ filename, status }) =>
			filename &&
			['package.json', 'package-lock.json', 'yarn.lock'].includes(filename) &&
			status === 'modified'
	);
	if (!onlyPackageJsonChanged) {
		core.error('More changed than the package.json and lockfile');
		return Result.FileNotAllowed;
	}

	core.info('Retrieving package.json');
	const packageJsonBase = await readPackageJson(pr.base.sha);
	const packageJsonPr = await readPackageJson(pr.head.sha);

	core.info('Calculating diff');
	const diff: any = detailedDiff(packageJsonBase, packageJsonPr);
	core.debug(JSON.stringify(diff, null, 2));
	if (Object.keys(diff.added).length || Object.keys(diff.deleted).length) {
		core.error('Unexpected changes');
		return Result.UnexpectedChanges;
	}

	core.info('Checking diff');

	const allowedPropsChanges = Object.keys(diff.updated).every((prop) => {
		return (
			['dependencies', 'devDependencies'].includes(prop) &&
			typeof diff.updated[prop] === 'object'
		);
	});
	if (!allowedPropsChanges) {
		core.error('Unexpected property change');
		return Result.UnexpectedPropertyChange;
	}

	const allowedChange = Object.keys(diff.updated).every((prop) => {
		const allowedBumpTypes = allowedUpdateTypes[prop] || [];
		const changedDependencies = diff.updated[prop];
		return Object.keys(changedDependencies).every((dependency) => {
			if (typeof changedDependencies[dependency] !== 'string') {
				return false;
			}
			if (packageBlockList.includes(dependency)) {
				return false;
			}
			const oldVersion = packageJsonBase[prop][dependency];
			const newVersion = packageJsonPr[prop][dependency];
			if (typeof oldVersion !== 'string' || typeof newVersion !== 'string') {
				return false;
			}
			return validVersionChange(oldVersion, newVersion, allowedBumpTypes);
		});
	});

	if (!allowedChange) {
		core.error('One or more version changes are not allowed');
		return Result.VersionChangeNotAllowed;
	}

	core.info('Enabling auto-merge');
	const result = await enableAutoMerge();
	core.info('Finished!');
	return result;
}
