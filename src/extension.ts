import * as vscode from 'vscode';
import { CopilotAccounts, CopilotTreeProvider, GITHUB_PROVIDER } from './copilot';

export function activate(context: vscode.ExtensionContext) {
	const copilotTree = new CopilotTreeProvider();
	const copilot = new CopilotAccounts(context, copilotTree);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('accountSwitcher.copilot', copilotTree),
		vscode.window.registerFileDecorationProvider(copilotTree),

		vscode.commands.registerCommand('accountSwitcher.refresh', () => copilotTree.refresh()),
		vscode.commands.registerCommand('accountSwitcher.copilot.switch', () => copilot.switchAccount()),
		vscode.commands.registerCommand('accountSwitcher.copilot.add', () => copilot.addAccount()),
		vscode.commands.registerCommand(
			'accountSwitcher.copilot.select',
			(account: vscode.AuthenticationSessionAccountInformation) => copilot.selectAccount(account)
		),

		vscode.authentication.onDidChangeSessions(e => {
			if (e.provider.id === GITHUB_PROVIDER) {
				copilotTree.refresh();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('accountSwitcher')) {
				copilotTree.refresh();
			}
		}),
		vscode.window.onDidChangeWindowState(e => {
			if (e.focused) {
				copilotTree.refresh();
			}
		})
	);
}

