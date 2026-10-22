# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Harv is a personal AI assistant in the spirit of Jarvis. The project is at the planning stage: no code exists yet, and the language, framework, and architecture have not been chosen. Do not assume a stack. Ask, or update this file once one is decided.

## Environment

- Development happens on Windows 11. Both PowerShell and Git Bash are available.
- Available runtimes: Node.js 24 and Python 3.14.
- The git default branch is `main`.
- Secrets such as API keys go in `.env`, which is gitignored. Commit only an `.env.example` that shows the variable names.

## Commands

None yet. Add build, run, lint, and test commands here (including how to run a single test) once the stack is chosen.

## Architecture

Not yet designed. Record the high-level structure here as it takes shape.

## Harv's safety model (agreed with the user; tweak as we go)

Every action Harv takes goes through a permission gate, implemented with Agent SDK hooks rather than prompt instructions, so it can't be skipped. There are four levels:

- **Green (run immediately):** read stats or files, web search, open apps, create files inside Harv's own workspace.
- **Yellow (back up, run, verify):** edit, move or rename user files. Back up first to `~/.harv/backups/<timestamp>/`, log the action, and offer Undo.
- **Red (confirm first):** delete, install or uninstall, kill processes, run scripts, change system settings or the registry, send messages or email, `git push`. The flow: safety check (an exact preview of the impact plus a protected-path check), then backup, then a confirmation card in the dashboard (Approve, Deny, or edit), then run, then verify, then log.
- **Blocked:** formatting drives, writing to `C:\Windows`, disabling antivirus or the firewall, reading stored credentials. Only the user can unblock these, in settings.

Always on: a stop button with a hotkey that cancels the current action, user-defined read-only protected folders, and a full action log.
