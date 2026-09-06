import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const GITHUB_PROVIDER = 'github';
const MANAGE_PREFS_COMMAND = '_manageAccountPreferencesForExtension';
const DEFAULT_SCOPES = ['read:user', 'user:email'];
const ACCOUNT_SCHEME = 'copilot-account';
// VS Code stores the Copilot Chat preference under its parent id (product.json inheritAuthAccountPreference).
const PREF_PARENT_EXTENSION = 'github.copilot';

let extensionContext: vscode.ExtensionContext;

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('copilotAccountSwitcher');
	return {
		targetExtension: cfg.get<string>('targetExtension', 'GitHub.copilot-chat'),
		showStatusBar: cfg.get<boolean>('showStatusBar', true),
	};
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

async function switchAccount(): Promise<void> {
	const { targetExtension } = getConfig();

	if (!vscode.extensions.getExtension(targetExtension)) {
		vscode.window.showErrorMessage(`Extension "${targetExtension}" is not installed.`);
		return;
	}
	if (!(await ensureManageCommandAvailable())) {
		return;
	}

	const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
	if (accounts.length === 0) {
		const pick = await vscode.window.showInformationMessage(
			'No GitHub accounts are signed in.',
			'Add GitHub Account'
		);
		if (pick) {
			await addAccount();
		}
		return;
	}

	// Opens VS Code's native picker: lists signed-in accounts plus "Use a new account...".
	await vscode.commands.executeCommand(MANAGE_PREFS_COMMAND, targetExtension, GITHUB_PROVIDER);
}

async function addAccount(): Promise<void> {
	try {
		const session = await vscode.authentication.getSession(GITHUB_PROVIDER, DEFAULT_SCOPES, {
			forceNewSession: true,
		});
		if (session) {
			const choice = await vscode.window.showInformationMessage(
				`Signed in as ${session.account.label}.`,
				'Use for Copilot'
			);
			if (choice) {
				await switchAccount();
			}
		}
	} catch (err) {
		if (err instanceof Error && /cancel/i.test(err.message)) {
			return;
		}
		vscode.window.showErrorMessage(`Failed to sign in: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function listAccounts(): Promise<void> {
	const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
	if (accounts.length === 0) {
		vscode.window.showInformationMessage('No GitHub accounts are signed in.');
		return;
	}
	const items: vscode.QuickPickItem[] = accounts.map(a => ({
		label: `$(github) ${a.label}`,
		description: a.id,
	}));
	items.push(
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(arrow-swap) Switch Copilot account...', alwaysShow: true },
		{ label: '$(add) Add another GitHub account...', alwaysShow: true }
	);
	const pick = await vscode.window.showQuickPick(items, {
		title: 'GitHub Accounts',
		placeHolder: 'Signed-in GitHub accounts',
	});
	if (pick?.label.startsWith('$(arrow-swap)')) {
		await switchAccount();
	} else if (pick?.label.startsWith('$(add)')) {
		await addAccount();
	}
}

class AccountsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.FileDecorationProvider {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private activeAccount: string | undefined;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		const [accounts, active] = await Promise.all([
			vscode.authentication.getAccounts(GITHUB_PROVIDER),
			readPreferredAccount(),
		]);
		if (active !== this.activeAccount) {
			this.activeAccount = active;
			this._onDidChangeFileDecorations.fire(undefined);
		}
		await vscode.commands.executeCommand('setContext', 'copilotAccountSwitcher.accountCount', accounts.length);
		const avatars = await Promise.all(accounts.map(a => avatarUri(a.label)));
		return accounts.map((a, i) => {
			const isActive = a.label === active;
			const item = new vscode.TreeItem(a.label);
			item.id = a.id;
			item.resourceUri = vscode.Uri.from({ scheme: ACCOUNT_SCHEME, path: `/${encodeURIComponent(a.label)}` });
			item.iconPath = avatars[i] ?? new vscode.ThemeIcon('account');
			item.description = isActive ? 'active' : undefined;
			item.tooltip = isActive ? 'Copilot is using this account' : 'Click to make Copilot use this account';
			item.contextValue = isActive ? 'activeAccount' : 'account';
			item.command = {
				command: 'copilotAccountSwitcher.selectAccount',
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
		const deco = new vscode.FileDecoration('★', 'Active Copilot account', new vscode.ThemeColor('charts.yellow'));
		deco.propagate = false;
		return deco;
	}
}

/** Reads Copilot's preferred GitHub account from VS Code's state DB (workspace first, then global). */
async function readPreferredAccount(): Promise<string | undefined> {
	const { targetExtension } = getConfig();
	const keys = [...new Set([PREF_PARENT_EXTENSION, targetExtension.toLowerCase()])].map(
		id => `${id}-${GITHUB_PROVIDER}`
	);
	const dbs = [extensionContext.storageUri, extensionContext.globalStorageUri]
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

const avatarCache = new Map<string, vscode.Uri | undefined>();

/** Avatar for a github.com login, downloaded once into global storage; undefined when unavailable (e.g. EMU accounts). */
async function avatarUri(login: string): Promise<vscode.Uri | undefined> {
	if (avatarCache.has(login)) {
		return avatarCache.get(login);
	}
	let result: vscode.Uri | undefined;
	try {
		const dir = path.join(extensionContext.globalStorageUri.fsPath, 'avatars');
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
	avatarCache.set(login, result);
	return result;
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

const QUICK_INPUT_COMMANDS = ['quickInput.first', 'quickInput.next', 'workbench.action.acceptSelectedQuickOpenItem'];

async function selectAccount(account: vscode.AuthenticationSessionAccountInformation, tree: AccountsTreeProvider) {
	const before = await readPreferredAccount();
	if (before === account.label) {
		vscode.window.setStatusBarMessage(`Copilot already uses ${account.label}`, 3000);
		return;
	}

	const { targetExtension } = getConfig();
	if (!vscode.extensions.getExtension(targetExtension)) {
		vscode.window.showErrorMessage(`Extension "${targetExtension}" is not installed.`);
		return;
	}
	if (!(await ensureManageCommandAvailable())) {
		return;
	}

	// The native picker lists accounts in the same order as getAccounts(), then a separator and "Use a new account...".
	const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
	const index = accounts.findIndex(a => a.id === account.id);
	if (index < 0) {
		tree.refresh();
		return;
	}

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
		const now = await readPreferredAccount();
		if (now !== before) {
			tree.refresh();
			if (now === account.label) {
				vscode.window.setStatusBarMessage(`$(github) Copilot now uses ${account.label}`, 4000);
			} else {
				vscode.window.showWarningMessage(
					`Copilot switched to ${now}, not ${account.label}. Use "Switch Account" to pick manually.`
				);
			}
			return;
		}
	}
	tree.refresh();
}

function delay(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	const tree = new AccountsTreeProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('copilotAccountSwitcher.accounts', tree),
		vscode.window.registerFileDecorationProvider(tree),
		vscode.commands.registerCommand('copilotAccountSwitcher.refresh', () => tree.refresh()),
		vscode.commands.registerCommand(
			'copilotAccountSwitcher.selectAccount',
			(account: vscode.AuthenticationSessionAccountInformation) => selectAccount(account, tree)
		),
		vscode.commands.registerCommand('copilotAccountSwitcher.switchAccount', switchAccount),
		vscode.commands.registerCommand('copilotAccountSwitcher.addAccount', addAccount),
		vscode.commands.registerCommand('copilotAccountSwitcher.listAccounts', listAccounts)
	);

	const statusBar = vscode.window.createStatusBarItem(
		'copilotAccountSwitcher.status',
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBar.name = 'Copilot Account Switcher';
	statusBar.command = 'copilotAccountSwitcher.switchAccount';
	context.subscriptions.push(statusBar);

	const refreshStatusBar = async () => {
		if (!getConfig().showStatusBar) {
			statusBar.hide();
			return;
		}
		const accounts = await vscode.authentication.getAccounts(GITHUB_PROVIDER);
		statusBar.text = `$(github) Copilot: ${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
		const md = new vscode.MarkdownString(undefined, true);
		md.appendMarkdown('**Switch Copilot account**\n\n');
		md.appendMarkdown(
			accounts.length ? accounts.map(a => `- $(github) ${a.label}`).join('\n') : '_No GitHub accounts signed in_'
		);
		statusBar.tooltip = md;
		statusBar.show();
	};

	context.subscriptions.push(
		vscode.authentication.onDidChangeSessions(e => {
			if (e.provider.id === GITHUB_PROVIDER) {
				tree.refresh();
				void refreshStatusBar();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('copilotAccountSwitcher')) {
				tree.refresh();
				void refreshStatusBar();
			}
		}),
		vscode.window.onDidChangeWindowState(e => {
			if (e.focused) {
				tree.refresh();
			}
		})
	);

	void refreshStatusBar();
}

