import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Account Switcher', () => {
	test('registers its commands', async () => {
		// onStartupFinished may not have fired yet when tests start.
		const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-account-switcher');
		assert.ok(ext, 'extension not found');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'accountSwitcher.copilot.switch',
			'accountSwitcher.copilot.add',
			'accountSwitcher.copilot.select',
			'accountSwitcher.refresh',
		]) {
			assert.ok(commands.includes(id), `missing command ${id}`);
		}
	});
});
