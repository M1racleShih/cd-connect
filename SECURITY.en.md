# Security policy

[中文](SECURITY.md) · [English](SECURITY.en.md)

## Supported environment

This policy covers cd-connect `0.4.x` and `0.5.x`; the current version is `0.5.0`. Earlier versions and unreleased development branches carry no security-fix commitment. The project is verified only on Linux, for one local user, with DSH Desktop `0.2.1-rc.2` and its `desktop` profile. Windows/macOS, remote or tunnel deployment, multiple users, and multi-tenant deployment are outside current support. The maintainer commits to no response deadline or long-term support period.

## Report vulnerabilities privately

Email [hanqshih@gmail.com](mailto:hanqshih@gmail.com). Do not open a public issue first or disclose exploitable details in public discussions.

Include:

- Affected version, Linux distribution, and DSH version.
- Reproduction steps, actual impact, and whether other local users or processes must participate.
- Necessary error information, with tokens, complete task records, real session content, and unrelated personal paths removed.

The maintainer will acknowledge receipt and discuss next steps privately. Fix and disclosure timing depend on impact and available fixes. There is no bug bounty program.

## Private credentials and task records

The bridge stores two kinds of private data under `cd-connect/` in the actual DSH home:

- `connection.json` contains a random Bearer token generated for this plugin activation and the local loopback URL, with mode `0600`. The local stdio adapter uses it to connect. Do not include its contents in issues, chats, or screenshots.
- `ledger/tasks.json` stores task text, actual native-session mappings, some tool evidence, review records, and request hashes. The directory has mode `0700` and the file `0600`. It may contain private code, paths, and business content. Treat it as local private data; never upload or publish the complete file.

The bridge holds only its own local connection credential and does not read DSH account secrets. DSH and the user manage native logs and task workspaces outside the task-record file. The bridge stores evidence indexes, digests, and workspace witnesses, without copying complete logs or file contents.

If a connection token may have leaked, disable or reload the plugin. A new activation generates a new token, and the previous listener closes. Do not test credential validity through a public issue.

## Uninstall and data retention

Removing the client connection or DSH plugin **does not delete** task records, request-deduplication records, native DSH sessions or logs, or artifacts in task workspaces. Consider manually deleting `cd-connect/ledger` under the actual DSH home only after fully exiting DSH, resolving outstanding tasks, and backing up needed records. Deletion removes deduplication, recovery, and review evidence; it is not a repair for duplicate requests or storage errors. Never delete task records or lock files while a process is running.

## Local single-user boundary

The service listens only on `127.0.0.1`, requires a Bearer credential, checks Host/Origin, and limits request-body size. This is a local single-user tool boundary, **not** a multi-tenant sandbox. Processes under the same system account, local users able to read those files, and root are outside its isolation. Do not expose the listener to the internet or claim it isolates untrusted users or provides a public-network security solution.

The bridge keeps DSH's model, tool permissions, and native human-approval policy. Task content cannot expand authorization. Execution completion does not establish security acceptance. Check public materials and local data as described in [contributing](CONTRIBUTING.en.md) before submitting changes.
