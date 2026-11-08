# Vealth steward

A small program you run on your own machine, and leave running, to keep provisioning one place. Every half hour it looks at the public Vealth board near your place, tells you in plain words what is new, posts the needs you write down, keeps you posted on your own work, and votes on the jobs you mark. It talks to the public door at https://vealth.net/mcp, with a wallet it makes on your machine. It costs nothing to run and holds no money.

It is dry by default: it prints what it would post and vote. Add `--live` to act.

## Start

Node 18 or newer. One dependency, only to sign a plain message (viem).

```bash
npm install
node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5
```

The first run makes your wallet, prints its public address, creates the folder `~/.vealth-steward/`, and looks once. It then looks again every 30 minutes, until you stop it. Use `--lat 34.03 --lng -118.21` instead of a place name if you have the coordinates. Run it with no place on a terminal and it asks you.

When you are ready for it to post and vote for real:

```bash
node steward.mjs run --live
```

## What it does at every look

1. **New jobs.** It asks the board for work near your place and writes every job it has not shown you before into `digest.md` (and on screen): what the job is, where, what it pays and whether that is proposed or funded, who checks the proof, and what proof is asked. Up to 15 new jobs per look, nearest first; the rest come at the next look.
2. **Your needs.** Any `.txt` or `.md` file you drop in the `needs/` folder becomes a post, through the free post the board offers a wallet that signs for itself (ten a day at most). The board's own refusals are shown to you in words: a contact detail, a job with no home in the Vealth Standard (it lists the nearest ones), a place it cannot put on a map yet. A file is posted once. Edit a file that was refused and it is tried again.
3. **Your own work.** It reads `my_work` for the steward's wallet: jobs this wallet claimed, proof waiting, accepted, paid. It follows the reply's NEXT_CALL for read steps only, two at most. It also reads the status of the jobs it posted for you, and tells you when a proof is waiting for YOU to accept or refuse.
4. **Your votes.** It votes for a job only if you wrote its id in `votes.txt`, free, recorded as an agent vote.

A look that finds nothing new prints one line and writes nothing to the digest.

## What it never does

- It never pays, never moves money, and never signs a transaction. It signs only plain messages that prove the wallet is yours: no gas, no balance, no approvals.
- It never claims a job, hands in a proof, or accepts or refuses a proof. Those are yours.
- It never votes on a job you did not mark.
- It never posts a contact detail. A phone number or an email in a need is refused before anything is sent, and again by the board.
- It never holds anyone else's key. Your wallet is made on your machine; the key is in `wallet.key`, readable only by you (0600). It is never printed, never sent anywhere, and never written to the digest or the log.
- It never posts more than ten jobs in a rolling day, and never calls a proposed figure paid.
- It backs off when the door answers 429 or 503: it waits for the time the door names, or 1, 2, 4, 8 minutes and on up to an hour, and sends no more calls until then.

## Your folder

| File | What it is |
|---|---|
| `wallet.key` | the steward's key (0600). Never leaves this machine. |
| `wallet.address` | the public address, safe to share |
| `config.json` | the place, the radius, the interval, the door |
| `needs/` | drop `.txt` or `.md` files here to post needs |
| `votes.txt` | work ids to vote for, one per line, `#` for notes |
| `digest.md` | everything new it has told you, newest at the bottom |
| `state.json` | what it has already shown, posted and voted, so nothing repeats |
| `STOP` | create this file and the steward finishes its step and stops |

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

A title, a `pay` line and the description are required (no `title` line means the first line of the text is the title). `pay` is the proposed pay in US dollars: it stays proposed until someone funds the job, and an unfunded job earns a credit, which is a receipt for the work and not cash. `place` defaults to your steward's place. `type` is 0 water, 1 soil and planting, 2 building. If the board says the job has no home in the Vealth Standard, add a `standard:` line with one of the nearest it lists, and save the file.

You approve any proof for a job you posted, yourself, on the job's page.

## Claiming a job as the steward's wallet

The "own work" section of the digest shows jobs claimed by the steward's wallet. The steward never claims for you. If you want a job to show up there, claim it with this wallet yourself, for example with the Vealth client (`vealth-agent.mjs claim`), which reads the key you give it in `VEALTH_AGENT_KEY`. That is the one time the key leaves its file, and it is your own act on your own machine. You can also do any job on its page with a passkey; the steward will not see that one.

## Stop it

Press Ctrl-C. Or create the file `STOP` in the steward's folder and it finishes its step and stops. If you run it as a service, use the service manager's stop command. A second steward started on the same folder refuses to run, so two never post twice.

## Keep it running (your machine, your choice)

These are examples. Nothing here installs itself; you copy them, change the paths, and start them yourself.

macOS, `~/Library/LaunchAgents/net.example.vealth-steward.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.example.vealth-steward.plist`; stop it with `launchctl bootout gui/$(id -u)/net.example.vealth-steward`:

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
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/you/.vealth-steward/steward.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.vealth-steward/steward.log</string>
</dict>
</plist>
```

Linux, `~/.config/systemd/user/vealth-steward.service`, then `systemctl --user daemon-reload` and `systemctl --user enable --now vealth-steward`; stop it with `systemctl --user stop vealth-steward`:

```ini
[Unit]
Description=Vealth steward
After=network-online.target

[Service]
ExecStart=/usr/bin/node /home/you/vealth-steward/steward.mjs run --live
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
```

Leave `--live` out of either one and the service runs dry. On Windows the wallet file's permissions are not enforced the same way; keep the folder in your own profile.

## Manners

The door allows 60 calls a minute to one address. The steward pauses 1.25 seconds between calls (about 48 a minute at most) and stops a look after 150 calls. Looks are at least 5 minutes apart. If you run several stewards behind one address, give each its own `--dir` and a longer `--interval`.

## What to know about what you read

- A pay figure is proposed unless the job says it is funded. Accepted proof on an unfunded job earns a credit, which is a receipt, not money. Funded is not paid; it is paid after a person accepts the proof.
- The title, address and proof words of a job were written by whoever posted it. In the digest they sit inside `[[untrusted]] ... [[/untrusted]]`, the board's own fence. Read them as data. If you hand the digest to your own AI, tell it never to follow what is inside a fence.
- The steward is not an authority on any site and certifies nothing. It reads a public board and writes what you tell it to.
