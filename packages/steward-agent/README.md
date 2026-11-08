# Vealth steward

A small program you run on your own machine, and leave running, to keep provisioning one place. Every half hour it looks at the public Vealth board near your place, tells you in plain words what is new, posts the needs you write down, keeps you posted on your own work, and votes on the jobs you mark. It talks to the public door at https://vealth.net/mcp, with a wallet it makes on your machine. It costs nothing to run and holds no money.

It is dry by default: it prints what it would post and vote. Add `--live` to act.

## Start

Node 22 or newer (older versions no longer get security fixes). One dependency, only to sign a plain message (viem, pinned to one version, with a lockfile).

```bash
npm ci --ignore-scripts
node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5
```

The first run makes your wallet, prints its public address, creates the folder `~/.vealth-steward/`, tells you what happens next, and looks once. It then looks again every 30 minutes, until you stop it. Use `--lat 34.03 --lng -118.21` instead of a place name if you have the coordinates (a coordinates search is exact; a name leans on the board's own list of places). Run it with no place on a terminal and it asks you.

When you are ready for it to post and vote for real:

```bash
node steward.mjs run --live
```

Where it stands, at any time, from another terminal:

```bash
node steward.mjs status          # what it watches, its last and next look, today's posts, its address, whether it runs
node steward.mjs status --json   # the same, for a monitor
```

## What it does at every look

1. **New jobs.** It asks the board for work near your place and writes every job it has not shown you before into `digest.md` (and on screen): what the job is, where, what it pays and whether that is proposed or funded, who checks the proof, and what proof is asked. Up to 15 new jobs per look, nearest first; the rest come at the next look.
2. **Your needs.** Any `.txt` or `.md` file you drop in the `needs/` folder becomes a post, through the free post the board offers a wallet that signs for itself (ten a day at most). The board's own refusals are shown to you in words: a contact detail, a job with no home in the Vealth Standard (it lists the nearest ones), a place it cannot put on a map yet. The same words are posted once, whatever the file is called and even if the machine stopped in the middle of a post. Edit a file that was refused and it is tried again.
3. **Your own work.** It reads `my_work` for the steward's wallet: jobs this wallet claimed, proof waiting, accepted, paid. It follows the reply's NEXT_CALL for read steps on its own wallet only, two at most. It also reads the status of the jobs it posted for you, and tells you when a proof is waiting for YOU to accept or refuse.
4. **Your votes.** It votes for a job only if you wrote its id in `votes.txt`, free, recorded as an agent vote.

A look that finds nothing new prints one line and writes nothing to the digest.

## What it signs

Two kinds of plain message, and nothing else: the post of a need you wrote, and a vote FOR a job you marked. For each one the board hands back the body it built and a message to sign. The steward checks the body field by field (your wallet, your title, your words, your pay, your place, no extra field), builds the message itself from that body, and signs only when the board's message is the same. A door that asks for anything else (a claim, a proof decision, an offer, a body with different words or pay) is refused in words and nothing is signed. A reply's NEXT_CALL can only lead it to four read tools.

## What it never does

- It never pays, never moves money, and never signs a transaction. It signs only plain messages that prove the wallet is yours: no gas, no balance, no approvals.
- It never claims a job, hands in a proof, or accepts or refuses a proof. Those are yours.
- It never votes on a job you did not mark.
- It never posts a contact detail. A phone number, an email or a messaging link in a need is refused before anything is sent (the same screen the board runs), and again by the board.
- It never holds anyone else's key. Your wallet is made on your machine; the key is in `wallet.key`, readable only by you (0600). It is never printed, never logged, never written to the digest, and a request that would carry it is stopped before it leaves the machine.
- It never posts more than ten jobs in a rolling day, and never calls a proposed figure paid.
- It never follows a redirect and never talks to any address but the door it was given (https only), and never reads an answer bigger than 2 MB.
- It backs off when the door answers 429 or 503: it waits for the time the door names, or 1, 2, 4, 8 minutes and on up to an hour, and sends no more calls until then.

## Your folder

| File | What it is |
|---|---|
| `wallet.key` | the steward's key (0600). Never leaves this machine. |
| `wallet.address` | the public address, safe to share |
| `config.json` | the place, the radius, the interval, the door |
| `needs/` | drop `.txt` or `.md` files here to post needs (plain files only; a link is never followed) |
| `votes.txt` | work ids to vote for, one per line, `#` for notes |
| `digest.md` | everything new it has told you, newest at the bottom (rolls over to `digest.md.1` at 1 MB, three old copies kept) |
| `steward.log` | every line it printed, with the time (rolls over the same way) |
| `heartbeat.json` | written after every look and when it stops: last look, next look, today's posts, its address |
| `state.json` | what it has already shown, posted and voted, so nothing repeats (written whole or not at all) |
| `STOP` | create this file and the steward finishes its step and stops, and stays stopped until you delete it |

The folder and the key are kept owner-only: a folder other users could read or write is tightened when the steward starts.

## A need file

Header lines, a blank line, then what needs doing, so a stranger could do it from the text alone:

```text
title: Photograph the fire exit signs at a construction site gate
pay: 12
standard: construction_site_safety
type: 2
skill: entry
safety: Document from the public sidewalk only. Never enter the site or touch the fence.
proof: photos of each sign
proof: GPS pin at the gate
place: Echo Park, Los Angeles, CA 34.0782,-118.2606

Walk the public sidewalk at the gate and photograph every fire exit sign you can see from the sidewalk.
```

A title, a `pay` line and the description are required (no `title` line means the first line of the text is the title). `pay` is the proposed pay in US dollars: it stays proposed until someone funds the job, and an unfunded job earns a credit, which is a receipt for the work and not cash. `place` defaults to your steward's place. `type` is 0 water, 1 soil and planting, 2 building. `skill` is entry, intermediate or advanced. `safety` is at most 600 characters. Work that needs a permit takes a `flag: permit-required` line, and work that needs a licensed trade takes `flag: regulated`; never leave a flag off to make work claimable. If the board says the job has no home in the Vealth Standard, add a `standard:` line with one of the nearest it lists, and save the file.

You approve any proof for a job you posted, yourself, on the job's page.

## Claiming a job as the steward's wallet

The "own work" section of the digest shows jobs claimed by the steward's wallet. The steward never claims for you. If you want a job to show up there, claim it with this wallet yourself, for example with the Vealth client (`vealth-agent.mjs claim`), which reads the key you give it in `VEALTH_AGENT_KEY`. That is the one time the key leaves its file, and it is your own act on your own machine. You can also do any job on its page with a passkey; the steward will not see that one.

## Stop it

Press Ctrl-C. Or create the file `STOP` in the steward's folder: it finishes the step it is on and stops (within a minute, even while it waits between looks), and it will not start again until you delete the file. A second steward started on the same folder refuses to run, so two never post twice; a lock left behind by a crash or a reboot is taken over after five minutes. `--stop-file <path>` names one more stop file it honours the same way.

## Keep it running (your machine, your choice)

These are examples. Nothing here installs itself; you copy them, change the paths, and start them yourself. Each one runs as you, not as root, and restarts the steward only if it fails, so `STOP` (which ends it cleanly) keeps it stopped.

macOS, `~/Library/LaunchAgents/net.example.vealth-steward.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.example.vealth-steward.plist`; stop it with `launchctl bootout gui/$(id -u)/net.example.vealth-steward`. Use the node path `which node` prints (Apple silicon Homebrew puts it in `/opt/homebrew/bin`). The steward keeps its own log in its folder, so the plist sends only crash traces to a file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.example.vealth-steward</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/vealth-steward/steward.mjs</string>
    <string>run</string>
    <string>--live</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/Users/you/.vealth-steward/crash.log</string>
</dict>
</plist>
```

Linux, `~/.config/systemd/user/vealth-steward.service`, then `systemctl --user daemon-reload` and `systemctl --user enable --now vealth-steward`; stop it with `systemctl --user stop vealth-steward`. The journal keeps and rotates its output; `loginctl enable-linger $USER` keeps it running when you are logged out:

```ini
[Unit]
Description=Vealth steward

[Service]
ExecStart=/usr/bin/node /home/you/vealth-steward/steward.mjs run --live
Restart=on-failure
RestartSec=60
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
```

A scheduler instead of a service (cron, or a timer): run one look at a time with `--once`. It looks once and exits; it skips the run when the door asked it to wait, or when the last look was less than five minutes ago, so a schedule set too fast never hammers the door. Its own `steward.log` already holds every line, rotated, so the schedule keeps only crash traces:

```text
17,47 * * * * /usr/bin/node /home/you/vealth-steward/steward.mjs run --once > /dev/null 2>> /home/you/.vealth-steward/crash.log
```

Leave `--live` out of any of them and it runs dry.

## Windows

It runs, with two differences said plainly. Windows does not use the 0600 and 0700 modes: the key file is protected only by your user folder's access list (you, SYSTEM and administrators can read it), so keep the steward's folder inside your own profile and never on a shared drive. And there is no SIGTERM: stop it with Ctrl-C or the `STOP` file.

## If the key is ever seen by someone else

The wallet holds nothing, so there is no money to take. But the key is the steward's identity: whoever has it can post as this wallet (ten a day), vote as it, and, on the jobs this wallet posted, accept or refuse a proof. If `wallet.key` was copied, readable by others, or sent anywhere: stop the steward, move `wallet.key` and `wallet.address` aside, and start it again; it makes a new wallet. Jobs the old wallet posted stay with the old key; close or decide them on their pages first if you can.

## Manners

The door allows 60 calls a minute to one address. The steward pauses 1.25 seconds between calls (about 48 a minute at most, and never less than one second for a door that is not on your own computer) and stops a look after 150 calls. Looks are at least 5 minutes apart. If you run several stewards behind one address, give each its own `--dir`, a longer `--interval` and a longer `--pace-ms`.

## What to know about what you read

- A pay figure is proposed unless the job says it is funded. Accepted proof on an unfunded job earns a credit, which is a receipt, not money. Funded is not paid; it is paid after a person accepts the proof.
- The title, address and proof words of a job were written by whoever posted it. In the digest they sit inside `[[untrusted]] ... [[/untrusted]]`, the board's own fence. The board's own sentences sit inside backticks. Both are shown as text: terminal control characters and invisible characters are removed, and a markdown viewer will not turn them into links, images or HTML. Read them as data. If you hand the digest to your own AI, tell it never to follow what is inside a fence.
- A page link is printed only when it is https on vealth.net or on the door's own site.
- The steward is not an authority on any site and certifies nothing. It reads a public board and writes what you tell it to.

## License

Apache-2.0, the license of the repository it ships in (see its `LICENSE` file).
