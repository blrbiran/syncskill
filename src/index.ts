#!/usr/bin/env node

import { Command } from 'commander';

export function createProgram(): Command {
  return new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');
}

const entryArg = process.argv[1];

if (typeof entryArg === 'string' && import.meta.url.endsWith(entryArg)) {
  createProgram().parse(process.argv);
}
