#!/usr/bin/env node
/**
 * A stand-in for a per-turn CLI backend (CliBackend e2e). Prints a session id on the
 * first run, records every invocation's args to FAKE_CLI_LOG, exits 0.
 */
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.FAKE_CLI_LOG
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`)
if (!args.includes('--resume')) process.stdout.write('thread_id: sess-42\n')
process.stdout.write(`ran with ${args.length} args\n`)
