import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Copilot Account Switcher', () => {
	test('registers its commands', async () => {
		// onStartupFinished may not have fired yet when tests start.
		const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'copilot-account-switcher');
		assert.ok(ext, 'extension not found');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'copilotAccountSwitcher.switchAccount',
			'copilotAccountSwitcher.addAccount',
			'copilotAccountSwitcher.listAccounts',
		]) {
			assert.ok(commands.includes(id), `missing command ${id}`);
		}
	});
});
