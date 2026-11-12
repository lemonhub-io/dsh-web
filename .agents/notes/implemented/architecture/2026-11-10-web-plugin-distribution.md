# Agent Note: Cordis Web plugin distribution

Status: implemented

English | [中文](2026-11-10-web-plugin-distribution.zh.md)

## Problem

The browser already runs the Cordis tree through a Node compatibility layer, but its package-manager subprocess is unavailable and its module loader accepts preconverted code. Community installation needs a distribution path that preserves existing plugin APIs and lifecycle ownership.

## Decision

Web releases are prepared builds of ordinary npm Cordis bundles. The author tool and on-demand Worker preparation reuse the existing module transform and records its generation and static requirements in `dsh.web`. The market index keeps format 1 and its native source, with an optional Web artifact URL and digest per release. [The community guide](../../../../apps/web/platform/plugin-community.md) owns author and user instructions.

The existing Plugin Manager owns inspection, profile dependencies, enablement, removal and change notifications. A Worker-provided adapter owns bounded archive decoding, static resolution, module cache invalidation and persistence. Package files live in the normal browser-backed profile node_modules tree. Installation records a disabled dependency; enabling uses the existing bundle composition and Cordis effects. Removal waits for contributions to stop before deleting files and cached modules.

## Alternatives considered

**Independent QuickJS SDK and installation database:** rejected because it requires existing Cordis plugins to adopt another API and duplicates lifecycle, inventory and persistence ownership. The [separate SDK proposal](../../rejected/architecture/2026-11-08-dsh-web-plugin-system.md) records that alternative.

**Run pnpm inside the compatibility layer:** the current host has neither a complete package-manager process environment nor a TypeScript compiler. Prepared distributions reuse the existing JavaScript transform without expanding the browser into a full Node installation service.

## Consequences

Cordis plugins receive host authority and require explicit source trust. This delivery path provides compatibility checks, not per-plugin security isolation. Native addons and unsupported Node capabilities are refused; dynamic requests can still fail during normal activation. Code, dependencies and selection survive browser reload through the existing platform storage. Upgrades retain the existing stop, remove and reinstall workflow rather than introducing another migration or recovery system.
