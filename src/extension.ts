import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { simpleGit } from 'simple-git';
import { OpenAIApi, Configuration } from 'openai';

let workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
const gitHelper = simpleGit(workspaceRoot);

async function getOpenAIKey(): Promise<string> {
	let openaiKey = vscode.workspace.getConfiguration('iDontCareAboutCommitMessage').get('openaiApiKey') as string | undefined;
	if (!openaiKey) {
		openaiKey = await vscode.window.showInputBox({ prompt: 'Enter your OpenAI API Key' });
		if (!openaiKey) {
			vscode.window.showErrorMessage('No OpenAI API Key provided.');
			return '';
		}
		await vscode.workspace.getConfiguration('iDontCareAboutCommitMessage').update('openaiApiKey', openaiKey, vscode.ConfigurationTarget.Global);
	}
	return openaiKey;
}

type CreateConventionalCommitOptions = {
	type: string;
	scope?: string;
	description: string;
	body?: string;
	footer?: string;
	isBreakingChange?: boolean;
};

const createConventionalCommit = ({
	type,
	scope,
	description,
	body,
	footer,
	isBreakingChange,
}: CreateConventionalCommitOptions) => {
	let commitMessage = `${type}${scope ? `(${scope})` : ""}${isBreakingChange ? "!" : ""
		}: ${description}`;

	if (body) {
		commitMessage += `\n\n${body}`;
	}

	if (isBreakingChange) {
		commitMessage += `\n\nBREAKING CHANGE: ${description}`;
	}

	if (footer) {
		commitMessage += `\n\n${footer}`;
	}

	return commitMessage;
};

async function createCommitMessage(gitInfo: string) {
	const openaiKey = await getOpenAIKey();
	if (!openaiKey) {
		return '';
	}
	const model = vscode.workspace.getConfiguration('iDontCareAboutCommitMessage').get('model') as string;
	const configuration = new Configuration({ apiKey: openaiKey });
	const openai = new OpenAIApi(configuration);

	const useConventionalCommit = vscode.workspace.getConfiguration('iDontCareAboutCommitMessage').get('useConventionalCommit') as boolean;
	if (useConventionalCommit) {
		const chatCompletion = await openai.createChatCompletion(
			{
				model: model,
				messages: [
					{
						role: "system",
						content: "only answer with single line of commit msg itself"
					},
					{
						role: "user",
						content: gitInfo
					}
				],
				functions: [
					{
						name: "createConventionalCommit",
						description: "Create a conventional commit message.",
						parameters: {
							type: "object",
							properties: {
								type: {
									type: "string",
									description: "The type of the commit."
								},
								scope: {
									type: "string",
									description: "The scope of the commit."
								},
								description: {
									type: "string",
									description: "The description of the commit."
								},
								body: {
									type: "string",
									description: "The body of the commit."
								},
								footer: {
									type: "string",
									description: "The footer of the commit."
								},
								isBreakingChange: {
									type: "boolean",
									description: "If the commit introduces a breaking change."
								}
							},
							required: ["type", "description", "body", "footer", "isBreakingChange"]
						}
					}
				],
				function_call: { name: "createConventionalCommit" }
			});

		const content = chatCompletion.data.choices[0].message?.function_call?.arguments;
		if (!content) {
			return '';
		}
		const contentJSON = JSON.parse(content) as CreateConventionalCommitOptions;
		return createConventionalCommit(contentJSON);
	} else {
		const chatCompletion = await openai.createChatCompletion(
			{
				model: model,
				messages: [
					{
						role: "system",
						content: "only answer with single line of commit msg itself"
					},
					{
						role: 'user',
						content: gitInfo
					}],
			});
		return chatCompletion.data.choices[0].message?.content || '';
	}
}

async function prepareGitOperation() {
	if (!workspaceRoot) {
		vscode.window.showInformationMessage('No workspace opened.');
		return null;
	}

	const diff = await gitHelper.add('.').diff(['--staged']);
	let gitInfo = '';

	if (!diff) {
		const gitStatusShort = await gitHelper.status(['--short']);
		if (!gitStatusShort.files.length) {
			vscode.window.showInformationMessage('No changes to commit');
			return null;
		}

		for (let file of gitStatusShort.files) {
			if (file.index === '?' && file.working_dir === '?') {
				const filePath = path.join(workspaceRoot, file.path);
				gitInfo += `New file: ${file.path}\n${fs.readFileSync(filePath, 'utf8')}\n`;
			}
		}
	} else {
		gitInfo = `git diff:\n${diff}`;
	}

	const openaiKey = await getOpenAIKey();
	if (!openaiKey) {
		vscode.window.showErrorMessage('No OpenAI API Key provided.');
		return null;
	}

	return { gitInfo, openaiKey };
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('gitCommitAI', async () => {
		const preparation = await prepareGitOperation();
		if (!preparation) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Processing Git Commit",
			cancellable: false
		}, async () => {
			const commitMsg = await createCommitMessage(preparation.gitInfo);
			await gitHelper.commit(commitMsg);
			vscode.window.showInformationMessage('Commit Successful!');
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('gitPushAI', async () => {
		const preparation = await prepareGitOperation();
		if (!preparation) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Processing Git Push",
			cancellable: false
		}, async () => {
			const commitMsg = await createCommitMessage(preparation.gitInfo);
			const currentBranch = await gitHelper.revparse(['--abbrev-ref', 'HEAD']);
			await gitHelper.commit(commitMsg).push('origin', currentBranch);
			vscode.window.showInformationMessage('Push Successful!');
		});
	}));
}

export function deactivate() { }
