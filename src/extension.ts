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

async function createCommitMessage(gitInfo: string) {
	const openaiKey = await getOpenAIKey();
	if (!openaiKey) {
		return '';
	}
	const model = vscode.workspace.getConfiguration('iDontCareAboutCommitMessage').get('model') as string;
	const configuration = new Configuration({ apiKey: openaiKey });
	const openai = new OpenAIApi(configuration);

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

async function prepareGitOperation() {
	try {
		if (!workspaceRoot) {
			throw new Error('No workspace opened.');
		}

		let diff = await gitHelper.diff();
		let gitInfo = '';

		if (!diff) {
			const gitStatusShort = await gitHelper.status(['--short']);
			if (!gitStatusShort.files.length) {
				throw new Error('No changes to commit');
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
			throw new Error('No OpenAI API Key provided.');
		}

		return { gitInfo, openaiKey };
	} catch (error) {
		if (error instanceof Error) {
			vscode.window.showErrorMessage(error.message);
			return null;
		}
	}
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
			vscode.window.showInformationMessage(preparation.gitInfo);
			const commitMsg = await createCommitMessage(preparation.gitInfo);
			await gitHelper.add('.').commit(commitMsg);
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
			await gitHelper.add('.').commit(commitMsg).push('origin', currentBranch);
			vscode.window.showInformationMessage('Push Successful!');
		});
	}));
}

export function deactivate() { }
