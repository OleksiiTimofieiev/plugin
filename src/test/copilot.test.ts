import * as assert from 'assert';
import proxyquire = require('proxyquire');
import type * as vscode from 'vscode';
import type { CopilotTreeProvider } from '../copilot';

const alice = { id: '1', label: 'alice' };
const bob = { id: '2', label: 'bob' };
const reloadCommand = 'workbench.action.reloadWindow';
const permissiveScopes = ['read:user', 'user:email', 'repo', 'workflow'];

interface SessionMetadata {
	account: vscode.AuthenticationSessionAccountInformation;
	scopes: string[];
}

interface Options {
	preferences?: (string | undefined)[];
	reloadOnSwitch?: boolean;
	missingExtension?: boolean;
	missingCommand?: boolean;
	switchError?: boolean;
	reloadError?: boolean;
	copilotConfig?: Record<string, unknown>;
	sessionError?: string;
	sessionResult?: SessionMetadata;
	onSessionRequest?: () => void;
	getAccounts?: () => Promise<readonly vscode.AuthenticationSessionAccountInformation[]>;
}

function createHarness(options: Options = {}) {
	const events: string[] = [];
	const messages: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const preferences = [...(options.preferences ?? ['alice', 'bob'])];
	const sessions: SessionMetadata[] = [
		{ account: alice, scopes: [...permissiveScopes] },
		{ account: bob, scopes: ['read:user', 'user:email'] },
	];
	const sessionRequests: { provider: string; scopes: string[]; options: vscode.AuthenticationGetSessionOptions }[] = [];
	const commandArguments: { command: string; args: unknown[] }[] = [];
	const scopeKey = (scopes: readonly string[]) => [...scopes].sort().join(' ');
	const config: Record<string, unknown> = {};
	if (options.reloadOnSwitch !== undefined) {
		config.reloadOnSwitch = options.reloadOnSwitch;
	}
	let motion: string | undefined;
	const api = {
		workspace: {
			getConfiguration: (section: string) => section === 'accountSwitcher' ? {
				get: (key: string, fallback: unknown) => config[key] ?? fallback,
			} : section === 'github.copilot' ? {
				get: (key: string, fallback: unknown) => options.copilotConfig?.[key] ?? fallback,
			} : {
				get: () => motion,
				inspect: () => ({ globalValue: motion }),
				update: async (_key: string, value: string | undefined) => {
					motion = value;
					events.push(`motion:${value}`);
				},
			},
		},
		ConfigurationTarget: { Global: 1, Workspace: 2 },
		extensions: {
			getExtension: () => options.missingExtension ? undefined : {},
		},
		authentication: {
			getAccounts: options.getAccounts ?? (async () => [alice, bob]),
			getSession: async (provider: string, scopes: string[], request: vscode.AuthenticationGetSessionOptions) => {
				sessionRequests.push({ provider, scopes: [...scopes], options: request });
				events.push('session:prepare');
				options.onSessionRequest?.();
				if (options.sessionError) {
					throw new Error(options.sessionError);
				}
				const account = request.account ?? bob;
				let session = options.sessionResult ?? sessions.find(s => s.account.id === account.id && scopeKey(s.scopes) === scopeKey(scopes));
				if (!session) {
					session = { account, scopes: [...scopes] };
					sessions.push(session);
				}
				events.push('session:ready');
				return { ...session, id: 'test-session', accessToken: 'test-token' };
			},
		},
		commands: {
			getCommands: async () => options.missingCommand ? [] : ['_manageAccountPreferencesForExtension'],
			executeCommand: async (command: string, ...args: unknown[]) => {
				commandArguments.push({ command, args });
				events.push(command);
				if (command === 'runCommands' && options.switchError) {
					throw new Error('picker failed');
				}
				if (command === reloadCommand && options.reloadError) {
					throw new Error('reload failed');
				}
			},
		},
		window: {
			setStatusBarMessage: (message: string) => {
				messages.push(message);
				return { dispose: () => events.push('spinner:disposed') };
			},
			showWarningMessage: async (message: string) => { warnings.push(message); },
			showErrorMessage: async (message: string) => { errors.push(message); },
			showInformationMessage: async (message: string) => { messages.push(message); },
			withProgress: async (_options: unknown, task: () => Promise<boolean>) => {
				events.push('progress:start');
				try {
					return await task();
				} finally {
					events.push('progress:end');
				}
			},
		},
	};
	const { CopilotAccounts, getConfig, getCopilotSessionScopes } = proxyquire.noCallThru().load('../copilot', {
		vscode: api,
	}) as typeof import('../copilot');
	const tree = {
		refresh: () => events.push('tree:refresh'),
		switchingTo: undefined,
	} as unknown as CopilotTreeProvider;
	const manager = new CopilotAccounts({} as vscode.ExtensionContext, tree);
	manager.readPreferredAccount = async () => {
		const preference = preferences.length > 1 ? preferences.shift() : preferences[0];
		events.push(`preference:${preference}`);
		return preference;
	};
	function resolveCopilotAccount(preferred: string): string | undefined {
		const scopeSets = getCopilotSessionScopes().includes('repo')
			? [permissiveScopes, ['user:email'], ['read:user']]
			: [['user:email'], ['read:user']];
		// Model VS Code's exact-scope preference match, then its single-accessible-session fallback.
		for (const scopes of scopeSets) {
			const matches = sessions.filter(s => scopeKey(s.scopes) === scopeKey(scopes));
			const chosen = matches.find(s => s.account.label === preferred) ?? (matches.length === 1 ? matches[0] : undefined);
			if (chosen) {
				return chosen.account.label;
			}
		}
		return undefined;
	}
	return { manager, tree, events, messages, warnings, errors, config, preferences, getConfig, getCopilotSessionScopes, sessionRequests, sessions, resolveCopilotAccount, commandArguments };
}

suite('Copilot account switching', function () {
	this.timeout(10000);

	test('enables automatic reload by default', () => {
		assert.strictEqual(createHarness().getConfig().reloadOnSwitch, true);
	});

	test('reloads once only after confirmation, motion restoration and progress cleanup', async () => {
		const h = createHarness();
		await h.manager.selectAccount(bob);

		const reloadIndex = h.events.indexOf(reloadCommand);
		assert.ok(reloadIndex >= 0);
		assert.strictEqual(h.events.filter(e => e === reloadCommand).length, 1);
		for (const event of ['session:ready', 'preference:bob', 'motion:undefined', 'spinner:disposed', 'progress:end']) {
			assert.ok(h.events.indexOf(event) >= 0 && h.events.indexOf(event) < reloadIndex, event);
		}
		assert.strictEqual(h.tree.switchingTo, undefined);
		assert.deepStrictEqual(h.warnings, []);
		assert.deepStrictEqual(h.errors, []);
	});

	test('repairs the exact scope mismatch even when bob is already preferred', async () => {
		const h = createHarness({ preferences: ['bob'] });
		assert.strictEqual(h.resolveCopilotAccount('bob'), 'alice');

		await h.manager.selectAccount(bob);

		assert.strictEqual(h.resolveCopilotAccount('bob'), 'bob');
		assert.deepStrictEqual(h.sessionRequests[0].scopes, permissiveScopes);
		assert.strictEqual(h.sessionRequests[0].options.account, bob);
		assert.ok(h.sessionRequests[0].options.createIfNone);
		assert.strictEqual(h.sessionRequests[0].options.forceNewSession, undefined);
		assert.ok(h.events.indexOf('session:ready') < h.events.indexOf('preference:bob'));
		assert.ok(h.events.indexOf('session:ready') < h.events.indexOf(reloadCommand));
	});

	test('prepares the selected account before driving the preference picker', async () => {
		const h = createHarness();
		await h.manager.selectAccount(bob);

		assert.ok(h.events.indexOf('session:ready') < h.events.indexOf('runCommands'));
		assert.strictEqual(h.resolveCopilotAccount('bob'), 'bob');
	});

	test('repairs scope mismatch even with reload disabled', async () => {
		const h = createHarness({ preferences: ['bob'], reloadOnSwitch: false });
		await h.manager.selectAccount(bob);

		assert.strictEqual(h.resolveCopilotAccount('bob'), 'bob');
		assert.ok(!h.events.includes(reloadCommand));
	});

	test('reuses an existing matching session without forcing a new login', async () => {
		const h = createHarness({ preferences: ['bob'] });
		h.sessions.push({ account: bob, scopes: [...permissiveScopes].reverse() });
		const count = h.sessions.length;
		await h.manager.selectAccount(bob);

		assert.strictEqual(h.sessions.length, count);
		assert.ok(h.events.includes(reloadCommand));
		assert.strictEqual(h.sessionRequests[0].options.forceNewSession, undefined);
	});

	for (const copilotConfig of [
		{ 'advanced.authPermissions': 'minimal' },
		{ advanced: { authPermissions: 'minimal' } },
	]) {
		test(`honors minimal permissions (${Object.keys(copilotConfig)[0]})`, async () => {
			const h = createHarness({ copilotConfig, preferences: ['bob'] });
			await h.manager.selectAccount(bob);

			assert.deepStrictEqual(h.sessionRequests[0].scopes, ['user:email']);
			assert.strictEqual(h.resolveCopilotAccount('bob'), 'bob');
			assert.ok(h.events.includes(reloadCommand));
		});
	}

	test('matches Copilot setting precedence: dotted value overrides the advanced object', () => {
		const h = createHarness({ copilotConfig: { 'advanced.authPermissions': 'default', advanced: { authPermissions: 'minimal' } } });
		assert.deepStrictEqual(h.getCopilotSessionScopes(), permissiveScopes);
	});

	for (const sessionResult of [
		{ account: alice, scopes: permissiveScopes },
		{ account: { id: 'other-id', label: bob.label }, scopes: permissiveScopes },
		{ account: { id: bob.id, label: 'other-login' }, scopes: permissiveScopes },
		{ account: bob, scopes: ['read:user', 'user:email'] },
	]) {
		test(`rejects incorrect session ${sessionResult.account.id}/${sessionResult.account.label}/${sessionResult.scopes.length}`, async () => {
			const h = createHarness({ sessionResult });
			await h.manager.selectAccount(bob);

			assert.ok(!h.events.includes('runCommands'));
			assert.ok(!h.events.includes(reloadCommand));
			assert.strictEqual(h.errors.length, 1);
		});
	}

	for (const sessionError of ['Canceled', 'User did not consent to login.', 'Network unavailable']) {
		test(`does not change preference or reload after authorization fails: ${sessionError}`, async () => {
			const options: Options = { sessionError };
			const h = createHarness(options);
			await h.manager.selectAccount(bob);

			assert.ok(!h.events.includes('runCommands'));
			assert.ok(!h.events.includes(reloadCommand));
			assert.deepStrictEqual(h.preferences, ['alice', 'bob']);
			assert.ok(h.messages.some(m => m.includes('canceled')) || h.errors.some(m => m.includes(sessionError)));
			options.sessionError = undefined;
			await h.manager.selectAccount(bob);
			assert.ok(h.events.includes(reloadCommand));
		});
	}

	test('rejects another Copilot auth provider rather than switching an unrelated GitHub account', async () => {
		const h = createHarness({ copilotConfig: { advanced: { authProvider: 'github-enterprise' } } });
		await h.manager.selectAccount(bob);

		assert.strictEqual(h.sessionRequests.length, 0);
		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.errors.some(m => m.includes('different authentication provider')));
	});

	test('aborts if authentication settings change while authorization is pending', async () => {
		const copilotConfig: Record<string, unknown> = {};
		const h = createHarness({ copilotConfig, onSessionRequest: () => { copilotConfig['advanced.authPermissions'] = 'minimal'; } });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes('runCommands'));
		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.errors.some(m => m.includes('settings changed')));
	});

	test('re-reads the native picker order after authorization', async () => {
		let accounts = [alice, bob];
		const h = createHarness({ getAccounts: async () => accounts, onSessionRequest: () => { accounts = [bob, alice]; } });
		await h.manager.selectAccount(bob);

		const invocation = h.commandArguments.find(c => c.command === 'runCommands');
		assert.ok(invocation);
		const sequence = invocation.args[0] as { commands: unknown[] };
		assert.ok(!sequence.commands.includes('quickInput.next'));
		assert.ok(h.events.includes(reloadCommand));
	});

	test('does not reload if the account disappears during authorization', async () => {
		let accounts = [alice, bob];
		const h = createHarness({ getAccounts: async () => accounts, onSessionRequest: () => { accounts = [alice]; } });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes('runCommands'));
		assert.ok(!h.events.includes(reloadCommand));
	});

	test('adds new accounts with Copilot-compatible scopes', async () => {
		const h = createHarness();
		await h.manager.addAccount();

		assert.deepStrictEqual(h.sessionRequests[0].scopes, permissiveScopes);
		assert.ok(h.sessionRequests[0].options.forceNewSession);
		assert.ok(!h.events.includes(reloadCommand));
		assert.strictEqual(h.resolveCopilotAccount('bob'), 'bob');
	});

	test('adds new accounts with minimal scopes in minimal mode', async () => {
		const h = createHarness({ copilotConfig: { advanced: { authPermissions: 'minimal' } } });
		await h.manager.addAccount();

		assert.deepStrictEqual(h.sessionRequests[0].scopes, ['user:email']);
		assert.ok(h.sessionRequests[0].options.forceNewSession);
	});

	test('keeps the window open when automatic reload is disabled', async () => {
		const h = createHarness({ reloadOnSwitch: false });
		await h.manager.selectAccount(bob);

		assert.ok(h.events.includes('runCommands'));
		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.messages.some(m => m.includes('preference set to bob')));
		assert.ok(!h.messages.some(m => m.includes('Copilot now uses')));
	});

	test('reselecting the saved account reloads without reopening the native picker', async () => {
		const h = createHarness({ preferences: ['bob'] });
		await h.manager.selectAccount(bob);

		assert.ok(h.events.includes(reloadCommand));
		assert.ok(!h.events.includes('runCommands'));
	});

	test('reselecting the saved account honors the reload opt-out', async () => {
		const h = createHarness({ preferences: ['bob'], reloadOnSwitch: false });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(!h.messages.some(m => m.includes('already uses')));
	});

	test('does not reload if the picker selects a different account', async () => {
		const h = createHarness({ preferences: ['alice', 'charlie'] });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.warnings.some(m => m.includes('charlie, not bob')));
	});

	test('waits through a transient unreadable preference', async () => {
		const h = createHarness({ preferences: ['alice', undefined, 'bob'] });
		await h.manager.selectAccount(bob);

		assert.ok(h.events.includes(reloadCommand));
		assert.deepStrictEqual(h.warnings, []);
	});

	test('confirms a first preference before reloading', async () => {
		const h = createHarness({ preferences: [undefined, 'bob'] });
		await h.manager.selectAccount(bob);

		assert.ok(h.events.includes(reloadCommand));
	});

	for (const preference of ['alice', undefined]) {
		test(`does not reload when confirmation times out (${preference ?? 'unreadable database'})`, async () => {
			const h = createHarness({ preferences: [preference] });
			await h.manager.selectAccount(bob);

			assert.ok(!h.events.includes(reloadCommand));
			assert.ok(h.warnings.some(m => m.includes('Could not confirm')));
			assert.strictEqual(h.tree.switchingTo, undefined);
		});
	}

	test('cleans up and allows retry after a picker failure', async () => {
		const options: Options = { switchError: true };
		const h = createHarness(options);
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.events.includes('motion:undefined'));
		assert.ok(h.events.includes('spinner:disposed'));
		assert.strictEqual(h.tree.switchingTo, undefined);
		assert.ok(h.errors.some(m => m.includes('picker failed')));

		options.switchError = false;
		h.preferences.splice(0, h.preferences.length, 'alice', 'bob');
		await h.manager.selectAccount(bob);
		assert.ok(h.events.includes(reloadCommand));
	});

	test('provides manual recovery if the reload command fails', async () => {
		const h = createHarness({ reloadError: true });
		await h.manager.selectAccount(bob);

		assert.ok(h.errors.some(m => m.includes('preference is set to bob') && m.includes('Developer: Reload Window')));
		assert.strictEqual(h.events.filter(e => e === reloadCommand).length, 1);
	});

	test('does not reload if the target extension is missing', async () => {
		const h = createHarness({ missingExtension: true, preferences: ['bob'] });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.errors.some(m => m.includes('not installed')));
	});

	test('does not reload when account management is unsupported', async () => {
		const h = createHarness({ missingCommand: true });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(h.errors.some(m => m.includes('does not support')));
	});

	test('does not reload for an account that is no longer signed in', async () => {
		const h = createHarness({ preferences: ['bob'], getAccounts: async () => [alice] });
		await h.manager.selectAccount(bob);

		assert.ok(!h.events.includes(reloadCommand));
		assert.ok(!h.events.includes('runCommands'));
	});

	test('ignores overlapping selections while a switch is in progress', async () => {
		let release!: (accounts: vscode.AuthenticationSessionAccountInformation[]) => void;
		const accounts = new Promise<vscode.AuthenticationSessionAccountInformation[]>(resolve => { release = resolve; });
		const h = createHarness({ getAccounts: () => accounts });
		const first = h.manager.selectAccount(bob);
		await h.manager.selectAccount(alice);
		release([alice, bob]);
		await first;

		assert.ok(h.messages.some(m => m.includes('already in progress')));
		assert.strictEqual(h.events.filter(e => e === 'runCommands').length, 1);
		assert.strictEqual(h.events.filter(e => e === reloadCommand).length, 1);
	});
});