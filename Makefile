.DEFAULT_GOAL := help

NODE ?= node
NPM ?= npm
CODE ?= code
VSCE_VERSION ?= 3.9.2
VSIX = $(shell "$(NODE)" -p "const p = require('./package.json'); p.name + '-' + p.version + '.vsix'")

.PHONY: help deps build package rebuild install

help:
	@printf '%s\n' \
		'make build    - Install locked dependencies, type-check, lint, and build' \
		'make rebuild  - Install locked dependencies and rebuild the production VSIX' \
		'make package  - Same as make rebuild' \
		'make install  - Rebuild the VSIX and install it into VS Code' \
		'' \
		'Override the editor CLI with CODE=code-insiders or CODE="/path/to/code".'

deps:
	"$(NPM)" ci --include=dev

build: deps
	"$(NPM)" run compile

package: deps
	# vsce runs the existing production build through vscode:prepublish.
	"$(NPM)" exec --yes --package=@vscode/vsce@$(VSCE_VERSION) -- vsce package --out "$(VSIX)"

rebuild: package

install: rebuild
	@command -v "$(CODE)" >/dev/null 2>&1 || { \
		printf '%s\n' 'VS Code CLI not found. Install the code command in PATH from the Command Palette, or set CODE.'; \
		exit 1; \
	}
	"$(CODE)" --install-extension "$(VSIX)" --force
	@printf '%s\n' 'Installed. Run "Developer: Reload Window" in VS Code to activate the update.'