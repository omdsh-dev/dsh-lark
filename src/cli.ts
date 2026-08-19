#!/usr/bin/env node
/**
 * Executable entry for the `dsh-lark-channel` command. Kept apart from
 * {@link module:dsh-lark-channel/provision} so importing the logic — from a
 * test, or from another tool — never runs it.
 * @module dsh-lark-channel/cli
 */

import { main } from './provision.ts'

await main(process.argv.slice(2))
