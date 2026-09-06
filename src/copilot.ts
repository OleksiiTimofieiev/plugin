import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const GITHUB_PROVIDER = 'github';
const MANAGE_PREFS_COMMAND = '_manageAccountPreferencesForExtension';
const COPILOT_SCOPES = ['read:user', 'user:email', 'repo', 'workflow'];
const COPILOT_MINIMAL_SCOPES = ['user:email'];
const ACCOUNT_SCHEME = 'copilot-account';
// VS Code stores the Copilot Chat preference under its parent id (product.json inheritAuthAccountPreference).
const PREF_PARENT_EXTENSION = 'github.copilot';
const QUICK_INPUT_COMMANDS = ['quickInput.first', 'quickInput.next', 'workbench.action.acceptSelectedQuickOpenItem'];

type Account = vscode.AuthenticationSessionAccountInformation;

export function getConfig() {
	const cfg = vscode.workspace.getConfiguration('accountSwitcher');
	return {
		targetExtension: cfg.get<string>('copilotExtension', 'GitHub.copilot-chat'),
		reloadOnSwitch: cfg.get<boolean>('reloadOnSwitch', true),
	};
}

export function getCopilotSessionScopes(): string[] {
	const cfg = vscode.workspace.getConfiguration('github.copilot');
	const advanced = cfg.get<{ authProvider?: string; authPermissions?: string }>('advanced');
	const provider = cfg.get<string>('advanced.authProvider') ?? advanced?.authProvider ?? GITHUB_PROVIDER;
	if (provider !== GITHUB_PROVIDER) {
		throw new Error('Copilot is configured for a different authentication provider. Account Switcher only supports github.com accounts.');
	}
	const permissions = cfg.get<string>('advanced.authPermissions') ?? advanced?.authPermissions;
	// GitHub matches exact scope sets; Copilot tries the permissive set first unless in minimal mode.
	return [...(permissions === 'minimal' ? COPILOT_MINIMAL_SCOPES : COPILOT_SCOPES)];
}

async function prepareCopilotSession(account?: Account): Promise<vscode.AuthenticationSession> {
	const scopes = getCopilotSessionScopes();
	const detail = scopes.includes('repo')
		? 'Copilot tries a session with read:user, user:email, repo and workflow permissions first. Authorize these permissions for the selected account to prevent fallback to another account. Account Switcher does not store or log tokens.'
		: 'Authorize a user:email session for Copilot\'s minimal-permissions mode. Account Switcher does not store or log tokens.';
	const session = await vscode.authentication.getSession(GITHUB_PROVIDER, scopes, account
		? { account, createIfNone: { detail } }
		: { forceNewSession: { detail } });
	if (!session || (account && (session.account.id !== account.id || session.account.label !== account.label))) {
		throw new Error('GitHub did not return a session for the selected account. The Copilot preference was not changed and the window was not reloaded.');
	}
	const expected = [...scopes].sort().join(' ');
	if ([...session.scopes].sort().join(' ') !== expected) {
		throw new Error('GitHub did not return the exact permissions Copilot needs. The Copilot preference was not changed and the window was not reloaded.');
	}
	if (getCopilotSessionScopes().sort().join(' ') !== expected) {
		throw new Error('Copilot authentication settings changed during sign-in. Try switching again.');
	}
	return session;
}

async function ensureManageCommandAvailable(): Promise<boolean> {
	// `true` would filter out internal (underscore-prefixed) commands like this one.
	const commands = await vscode.commands.getCommands(false);
	if (commands.includes(MANAGE_PREFS_COMMAND)) {
		return true;
	}
	vscode.window.showErrorMessage(
		'This version of VS Code does not support per-extension account preferences. Please update VS Code.'
	);
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

export class CopilotAccounts {
	private readonly avatarCache = new Map<string, vscode.Uri | undefined>();
	private switchInProgress = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly tree: CopilotTreeProvider
	) {
		tree.accounts = this;
	}

	/** Reads Copilot's preferred GitHub account from VS Code's state DB (workspace first, then global). */
	async readPreferredAccount(): Promise<string | undefined> {
		const { targetExtension } = getConfig();
		const keys = [...new Set([PREF_PARENT_EXTENSION, targetExtension.toLowerCase()])].map(
			id => `${id}-${GITHUB_PROVIDER}`
		);
		const dbs = [this.context.storageUri, this.context.globalStorageUri]
			.filter((u): u is vscode.Uri => !!u)
			.map(u => path.join(path.dirname(u.fsPath), 'state.vscdb'))
			.filter(p => fs.existsSync(p));

		for (const db of dbs) {
			for (const key of keys) {
				const value = await queryStateDb(db, key);
				if (value) {
					return value;
				}
			}
		}
		return undefined;
	}

	/** Avatar for a github.com login, downloaded once into global storage; undefined when unavailable (e.g. EMU accounts). */
	async avatarUri(login: string): Promise<vscode.Uri | undefined> {
		if (this.avatarCache.has(login)) {
			return this.avatarCache.get(login);
		}
		let result: vscode.Uri | undefined;
		try {
			const dir = path.join(this.context.globalStorageUri.fsPath, 'avatars');
			const file = path.join(dir, `${login.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`);
			if (!fs.existsSync(file)) {
				const res = await fetch(`https://github.com/${encodeURIComponent(login)}.png?size=32`, {
					signal: AbortSignal.timeout(4000),
				});
				if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
					throw new Error(`no avatar (${res.status})`);
				}
				await fs.promises.mkdir(dir, { recursive: true });
				await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
			}
			result = vscode.Uri.file(file);
		} catch {
			result = undefined;
		}
		this.avatarCache.set(login, result);
		return result;
	}

	async switchAccount(): Promise<void> {
		const { targetExtension } = getConfig();
		if (!vscode.extensions.getExtension(targetExtension)) {
			vscode.window.showErrorMessage(`Extension "${targetExtension}" is not installed.`);
			return;
		}
		if (!(await ensureManageCommandAvailable())) {
			return;
		}

		interface PickItem extends vscode.QuickPickItem {
			account?: Account;
			addNew?: boolean;
		}
		const picker = vscode.window.createQuickPick<PickItem>();
		picker.title = 'Switch Copilot Account';
		picker.placeholder = 'Loading GitHub accounts...';
		picker.matchOnDescription = true;
		picker.busy = true;
		picker.show();

		const [accounts, active] = await Promise.all([
			vscode.authentication.getAccounts(GITHUB_PROVIDER),
			this.readPreferredAccount(),
		]);
		const avatars = await Promise.all(accounts.map(a => this.avatarUri(a.label)));

		const items: PickItem[] = accounts.map((a, i) => {
			const isActive = a.label === active;
			return {
				account: a,
				label: a.label,
				description: isActive ? '$(star-full) Preferred account' : undefined,
				iconPath: avatars[i] ?? new vscode.ThemeIcon('account'),
				picked: isActive,
			};
		});
		items.push(
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ addNew: true, label: 'Use a new account...', iconPath: new vscode.ThemeIcon('add'), alwaysShow: true }
		);
		picker.items = items;
		picker.activeItems = items.filter(i => i.picked);
		picker.placeholder = accounts.length
			? (getConfig().reloadOnSwitch
				? 'Select the GitHub account for Copilot (reloads this window)'
				: 'Select the GitHub account Copilot should use')
			: 'No GitHub accounts are signed in';
		picker.busy = false;

		const choice = await new Promise<PickItem | undefined>(resolve => {
			picker.onDidAccept(() => resolve(picker.selectedItems[0]));
			picker.onDidHide(() => resolve(undefined));
		});
		picker.dispose();

		if (choice?.addNew) {
			await this.addAccount();
		} else if (choice?.account) {
			await this.selectAccount(choice.account);
		}
	}

	async addAccount(): Promise<void> {
		try {
			const session = await prepareCopilotSession();
			if (session) {
				const choice = await vscode.window.showInformationMessage(
					`Signed in as ${session.account.label}.`,
					'Use for Copilot'
				);
				if (choice) {
					await this.selectAccount(session.account);
				}
			}
		} catch (err) {
			if (err instanceof Error && /cancel/i.test(err.message)) {
				return;
			}
			vscode.window.showErrorMessage(`Failed to sign in: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async selectAccount(account: Account): Promise<void> {
		if (this.switchInProgress) {
			vscode.window.setStatusBarMessage('A Copilot account switch is already in progress.', 3000);
			return;
		}

		this.switchInProgress = true;
		try {
			const { targetExtension } = getConfig();
			if (!vscode.extensions.getExtension(targetExtension)) {
				vscode.window.showErrorMessage(`Extension "${targetExtension}" is not installed.`);
				return;
			}

			const signedIn = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
			if (!signedIn.some(a => a.id === account.id)) {
				this.tree.refresh();
				return;
			}
			if (!(await ensureManageCommandAvailable())) {
				return;
			}
			await prepareCopilotSession(account);

			// Authorization can reorder accounts; the native picker uses the latest getAccounts() order.
			const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
			const index = accounts.findIndex(a => a.id === account.id);
			if (index < 0) {
				this.tree.refresh();
				return;
			}
			const before = await this.readPreferredAccount();
			if (before === account.label) {
				await this.completeSwitch(account);
				return;
			}

			const confirmed = await vscode.window.withProgress(
				{ location: { viewId: 'accountSwitcher.copilot' } },
				() => this.performSwitch(account, before, index, targetExtension)
			);
			if (confirmed) {
				await this.completeSwitch(account);
			}
		} catch (err) {
			if (err instanceof Error && /cancel|did not consent/i.test(err.message)) {
				vscode.window.setStatusBarMessage('Copilot account switch canceled. The window was not reloaded.', 4000);
				return;
			}
			vscode.window.showErrorMessage(
				`Failed to switch Copilot account: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			this.switchInProgress = false;
		}
	}

	private async completeSwitch(account: Account): Promise<void> {
		if (!getConfig().reloadOnSwitch) {
			vscode.window.setStatusBarMessage(
				`$(github) Copilot preference set to ${account.label}. Reload the window if Copilot still uses the previous account.`,
				6000
			);
			return;
		}
		vscode.window.setStatusBarMessage(`Reloading window to use ${account.label} for Copilot...`, 4000);
		try {
			// Copilot exposes no supported API to force and verify its live account.
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		} catch {
			vscode.window.showErrorMessage(
				`Copilot preference is set to ${account.label}, but the window could not reload. Run "Developer: Reload Window" to reinitialize Copilot.`
			);
		}
	}

	private async performSwitch(account: Account, before: string | undefined, index: number, targetExtension: string): Promise<boolean> {
		const spinner = vscode.window.setStatusBarMessage(`$(sync~spin) Switching Copilot to ${account.label}...`);
		this.tree.switchingTo = account.id;
		this.tree.refresh();
		try {
			// The first call of any command awaits an `onCommand:` activation round-trip, which would let a frame
			// paint mid-sequence. Run them once now (no-ops while no quick pick is open) so they're warm.
			await Promise.all(QUICK_INPUT_COMMANDS.map(c => vscode.commands.executeCommand(c)));

			// Run the whole sequence inside the renderer via `runCommands`: no extension-host round trips
			// between steps, so the picker is shown, navigated and accepted before a frame can be painted.
			await withReducedMotion(async () => {
				await vscode.commands.executeCommand('runCommands', {
					commands: [
						{ command: MANAGE_PREFS_COMMAND, args: [targetExtension, GITHUB_PROVIDER] },
						'quickInput.first',
						...Array<string>(index).fill('quickInput.next'),
						'workbench.action.acceptSelectedQuickOpenItem',
					],
				});
			});

			for (let i = 0; i < 20; i++) {
				await delay(250);
				const now = await this.readPreferredAccount();
				if (now === account.label) {
					return true;
				}
				if (now && now !== before) {
					vscode.window.showWarningMessage(
						`Copilot preference changed to ${now}, not ${account.label}. The window was not reloaded. Use "Switch Copilot Account" to try again.`
					);
					return false;
				}
			}
			vscode.window.showWarningMessage(
				`Could not confirm the switch to ${account.label}. The window was not reloaded. Check that sqlite3 is available, then use "Switch Copilot Account" to try again.`
			);
			return false;
		} finally {
			spinner.dispose();
			this.tree.switchingTo = undefined;
			this.tree.refresh();
		}
	}
}

function queryStateDb(db: string, key: string): Promise<string | undefined> {
	// Keys are fixed extension/provider ids, but escape quotes anyway.
	const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1;`;
	return new Promise(resolve => {
		execFile('sqlite3', ['-readonly', db, sql], { timeout: 3000 }, (err, stdout) => {
			if (err) {
				resolve(undefined);
				return;
			}
			const v = stdout.trim();
			resolve(v.length ? v : undefined);
		});
	});
}

/** Quick-input open/close animations only run with motion enabled; disable it while the picker is driven. */
async function withReducedMotion<T>(fn: () => Promise<T>): Promise<T> {
	const cfg = vscode.workspace.getConfiguration('workbench');
	if (cfg.get<string>('reduceMotion') === 'on') {
		return fn();
	}
	const info = cfg.inspect<string>('reduceMotion');
	const target = info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	const previous = target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
	let changed = false;
	try {
		await cfg.update('reduceMotion', 'on', target);
		changed = true;
	} catch {
		// settings.json not writable; proceed with animations.
	}
	try {
		return await fn();
	} finally {
		if (changed) {
			await cfg.update('reduceMotion', previous, target).then(undefined, () => undefined);
		}
	}
}

export class CopilotTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.FileDecorationProvider {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	accounts!: CopilotAccounts;
	private activeAccount: string | undefined;
	switchingTo: string | undefined;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		const [accounts, active] = await Promise.all([
			vscode.authentication.getAccounts(GITHUB_PROVIDER),
			this.accounts.readPreferredAccount(),
		]);
		if (active !== this.activeAccount) {
			this.activeAccount = active;
			this._onDidChangeFileDecorations.fire(undefined);
		}
		await vscode.commands.executeCommand('setContext', 'accountSwitcher.copilotCount', accounts.length);
		const avatars = await Promise.all(accounts.map(a => this.accounts.avatarUri(a.label)));
		return accounts.map((a, i) => {
			const isActive = a.label === active;
			const isSwitching = a.id === this.switchingTo;
			const item = new vscode.TreeItem(a.label);
			item.id = a.id;
			item.resourceUri = vscode.Uri.from({ scheme: ACCOUNT_SCHEME, path: `/${encodeURIComponent(a.label)}` });
			item.iconPath = isSwitching
				? new vscode.ThemeIcon('loading~spin')
				: (avatars[i] ?? new vscode.ThemeIcon('account'));
			item.description = isSwitching ? 'switching...' : isActive ? 'preferred' : undefined;
			item.tooltip = getConfig().reloadOnSwitch
				? 'Click to select this account and reload the window for Copilot'
				: 'Click to set the preferred Copilot account (live session not verified)';
			item.contextValue = isActive ? 'copilotActive' : 'copilotAccount';
			item.command = {
				command: 'accountSwitcher.copilot.select',
				title: 'Use for Copilot',
				arguments: [a],
			};
			return item;
		});
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== ACCOUNT_SCHEME || !this.activeAccount) {
			return undefined;
		}
		if (decodeURIComponent(uri.path.slice(1)) !== this.activeAccount) {
			return undefined;
		}
		const deco = new vscode.FileDecoration('★', 'Preferred Copilot account', new vscode.ThemeColor('charts.yellow'));
		deco.propagate = false;
		return deco;
	}
}
