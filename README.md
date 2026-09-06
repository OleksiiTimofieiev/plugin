# Copilot Account Switcher

Quickly switch which GitHub account GitHub Copilot uses in VS Code, without signing out of your other accounts.

## How it works

VS Code lets you be signed in to several GitHub accounts at once and keeps a per-extension "preferred account". This extension exposes that mechanism for Copilot:

```mermaid
%%{init: {
  "theme": "base",
  "themeVariables": {
    "fontFamily": "ui-sans-serif, system-ui, sans-serif",
    "primaryColor": "#1f2937",
    "primaryTextColor": "#f1f5f9",
    "primaryBorderColor": "#60a5fa",
    "secondaryColor": "#312e81",
    "tertiaryColor": "#111827",
    "lineColor": "#8892a0",
    "textColor": "#f1f5f9",
    "clusterBkg": "#111827",
    "clusterBorder": "#4b5563",
    "edgeLabelBackground": "#1f2937"
  }
}}%%
flowchart LR
    classDef entry fill:#1f2937,stroke:#a78bfa,color:#f1f5f9,stroke-width:1.5px
    classDef logic fill:#1f2937,stroke:#60a5fa,color:#f1f5f9,stroke-width:1.5px
    classDef vscode fill:#0f2a44,stroke:#38bdf8,color:#f1f5f9,stroke-width:1.5px
    classDef github fill:#14261e,stroke:#34d399,color:#f1f5f9,stroke-width:1.5px
    classDef result fill:#2b2410,stroke:#facc15,color:#fef3c7,stroke-width:2px

    subgraph Entry["Entry points"]
        A["Activity Bar view<br/>click an account"]
        B["Status bar item"]
        C["Command Palette /<br/>Cmd+Alt+Shift+A"]
    end

    A & B & C --> S["switchAccount()"]
    S --> Chk{"Copilot Chat installed<br/>&amp; any GitHub accounts?"}
    Chk -- "no accounts" --> Add["addAccount()<br/>getSession(forceNewSession)"]
    Add --> GH["GitHub OAuth"] --> Acc["New account added"] --> S
    Chk -- "yes" --> Cmd["_manageAccountPreferencesForExtension<br/>(GitHub.copilot-chat, github)"]
    Cmd --> Pick["Native account picker"]
    Pick --> Pref["VS Code stores preferred account<br/>(state.vscdb)"]
    Pref --> Copilot["Copilot Chat uses<br/>the selected account"]
    Pref -. "read back" .-> View["View highlights<br/>active account ★"]

    class A,B,C entry
    class S,Chk,Add logic
    class Cmd,Pick,Pref vscode
    class GH,Acc github
    class Copilot,View result
```

```mermaid
%%{init: {
  "theme": "base",
  "themeVariables": {
    "fontFamily": "ui-sans-serif, system-ui, sans-serif",
    "primaryColor": "#1f2937",
    "primaryTextColor": "#f1f5f9",
    "primaryBorderColor": "#60a5fa",
    "actorBkg": "#1f2937",
    "actorBorder": "#60a5fa",
    "actorTextColor": "#f1f5f9",
    "actorLineColor": "#4b5563",
    "signalColor": "#8892a0",
    "signalTextColor": "#8892a0",
    "labelBoxBkgColor": "#1f2937",
    "labelBoxBorderColor": "#60a5fa",
    "labelTextColor": "#f1f5f9",
    "loopTextColor": "#f1f5f9",
    "noteBkgColor": "#2b2410",
    "noteBorderColor": "#facc15",
    "noteTextColor": "#fef3c7",
    "activationBkgColor": "#312e81",
    "activationBorderColor": "#a78bfa",
    "sequenceNumberColor": "#0b1220"
  }
}}%%
sequenceDiagram
    autonumber
    actor U as User
    participant E as Account Switcher
    participant V as VS Code Auth
    participant G as GitHub Provider
    participant C as Copilot Chat

    U->>E: Click "bob" in the view
    E->>V: getAccounts("github")
    V-->>E: [alice, bob]
    E->>V: _manageAccountPreferencesForExtension(copilot-chat, github)
    V->>U: Quick pick: alice / bob ★ / Use a new account...
    U->>V: Confirm bob
    V->>V: setPreferredAccount(copilot-chat, bob)
    Note over E,V: Switcher polls state.vscdb and refreshes
    E->>E: Mark bob as active (yellow ★)
    C->>V: getSession("github")
    V->>G: Session for bob
    G-->>C: Token
```

- **Copilot Accounts** view in the Activity Bar — lists signed-in GitHub accounts with their GitHub avatars; the account Copilot currently uses is highlighted in yellow with a ★. Click another account to switch to it (the native picker opens — confirm with Enter). Title-bar actions let you switch, add, or refresh.
- **Copilot Account: Switch Account** (`Cmd+Alt+Shift+A` / `Ctrl+Alt+Shift+A`) — opens the native account picker for the Copilot Chat extension. Pick an account, or choose *Use a new account...* to sign in to another one.
- **Copilot Account: Add GitHub Account** — signs in to an additional GitHub account, then offers to switch Copilot to it.
- **Copilot Account: List GitHub Accounts** — shows every signed-in GitHub account.
- A status bar item (`$(github) Copilot: N accounts`) opens the switcher on click.

After switching, Copilot Chat picks up the new account; if it does not, run **Developer: Reload Window**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `copilotAccountSwitcher.targetExtension` | `GitHub.copilot-chat` | Which Copilot extension's account preference to change (`GitHub.copilot-chat` or `GitHub.copilot`). |
| `copilotAccountSwitcher.showStatusBar` | `true` | Show the status bar item. |

## Requirements

- VS Code 1.96 or newer (multi-account support and `_manageAccountPreferencesForExtension`).
- GitHub Copilot Chat installed.
- `sqlite3` on your `PATH` (preinstalled on macOS and most Linux distros) — used read-only to detect which account Copilot currently prefers. Without it the view still works, but no account is highlighted.

## Development

```sh
npm install
npm run compile   # type-check, lint, bundle
npm test          # run extension tests
```

Press `F5` to launch an Extension Development Host.
