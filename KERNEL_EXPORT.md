# Kernel export

Files below are copied verbatim from the private Vealth repository by `scripts/publish/kernel-export.sh` at that repo's commit `d982e371d966475cef7b2bd2f424e98b1f8cb938` on 2026-11-08T06:42:15Z.
Most of them are also served live at https://vealth.net (the standard at /labor/standard, the tool list at /mcp, the client at /vealth-agent.mjs), and the live site stays the authority for those. The constitution, the worker sidecar and the packet-review skill are not served there; they are published here. This copy gives every file a home with history.

| Path | sha256 |
|---|---|
| `README.md` | `659ae98e1af683fbe196043c292058397dc157bb786f4c43d41b1ab306a09794` |
| `BUY.md` | `5be91e4d187517cf95a5dc3e3532f21605e396a476435ec1a009516af307dedb` |
| `packages/agent-client/vealth-agent.mjs` | `c04706d514fddbeac71a7c1cd4fad095718cae466011da4e2b7a7a1a754da951` |
| `schemas/vealth-standard-v0.json` | `36efb029aa8a24c8d1e52379ee9e5005d964412ebca46afa9564dd68c1d084bb` |
| `schemas/vealth-work-grant-v0.schema.json` | `45d910a1907878a64eb68f6b2402da2c06b00b7e58e5048736bbc0c09f5771c7` |
| `contracts/vealth-work-control.json` | `664edb443396dc4b7917456de80bab4f37e26e9e965f6f629fe6f0058dcd66f1` |
| `contracts/is-this-safe.json` | `32a00e5dff3d9970479a468fa6910089d9bda4c14e2bd12c580cd22b30c3f8d4` |
| `contracts/llms.txt` | `30857c5ebd8f6d4a67a954b09d99207cb4174fe0c655ed1b4c383ee2c4523c10` |
| `contracts/mcp-tools.json` | `df9172310547453e6c9952994c2d088860810a5c77aa2efb5b30410502a41fbf` |
| `docs/ecowealth-constitution.md` | `fa5d86dcaf9eb54ecfe68588752c2ddfb3387532c0adcba47e1c5c794e892cdd` |
| `packages/vcwp-sidecar/vcwp-sidecar.mjs` | `5518c37dd47010130202f96e267faaf7542a972b82a4c949981e2c43aa33033a` |
| `packages/vcwp-sidecar/README.md` | `d1f51ace66910ba51812541f070e91582c3d26d26a584bc52fcc01303fa07d22` |
| `docs/agent-execution-continuity.md` | `5fdd555c5bcb09ed21ec2d3cd2a1648e5249417b8eee7739df527ad1c103d1b7` |
| `skills/ewp-packet-review/SKILL.md` | `c8ec55b4c622bf387c7eee48dac0ff9ccb55e154b766418de2490973619b2e25` |
| `skills/ewp-packet-review/review-packet.mjs` | `95e369474065d520148c62808e678af89a06a039a8d414ef52205d183a13fb2d` |
| `skills/ewp-packet-review/fixture-packet.json` | `68043432dfd73a39b3aba65d853c8d239f15d2e230e53f21ec20d4ca8ac5948b` |
| `skills/ewp-packet-review/README.md` | `c6aa88aad833fcb240967d873567f6b6dcd22aabf8df0d13ee4bc59ad8c2c8c7` |
| `docs/human-reviewed-ai-safety-report-v0.md` | `33f208eb1882a8b320d02ec8f5937e8305941dddb1be4d7f215f886090953b5a` |
| `schemas/human-reviewed-ai-safety-report-v0.schema.json` | `610ebf3b876e1d26f871b3a16d1da01507e11f6d593755fd3091ea2e460491db` |
| `packages/hrsr-validate/hrsr-validate.mjs` | `8ec126da7eda0ecdae8324dd5bd86eb44485e193b8e8d87d571c424374ebcfb9` |
| `examples/human-reviewed-ai-safety-report/README.md` | `6d79d71218d6dc980040a5c7a2426ff69518cc01f1c93934f76ef44363c56952` |
| `examples/human-reviewed-ai-safety-report/sample-report.json` | `65ce7c059d0800c23ad5b6fab42877dfe41f8fa0964be62cdf7d18a3c6a9f156` |
| `examples/human-reviewed-ai-safety-report/notes.txt` | `e5d7133be797c5b0755b5bb4d46eb88edfc4f680f67ea42b2a0042910c396c6f` |
| `examples/human-reviewed-ai-safety-report/draft-report.md` | `c20b61b71b20280b4bc8d441f0e976c964c399844046210fde0429c2d8417d59` |
| `examples/human-reviewed-ai-safety-report/final-report.md` | `6f79b90dbb4a86c0a0fddf59515981280ad0cfd09a818bb8f451a0bd6c512de7` |
| `examples/human-reviewed-ai-safety-report/photo-01.txt` | `edfe77c5ca9a78a60d2fc03b7f4f9773f65b1ecd838c239ba3f0517f20a1b400` |
| `examples/human-reviewed-ai-safety-report/photo-02.txt` | `16967860b19c5aa86b1da09cc1f8658bedff7518fe1f4468cf642feb770e0ddd` |
| `examples/human-reviewed-ai-safety-report/photo-03.txt` | `14d2b7e17c5fdb077f76772533ecf24c10a3a08c3701878a1b819afcc84eaa53` |
| `packages/steward-agent/steward.mjs` | `8d6c99c8daa84eb2435dbe1c08dd98e2e637e511240dbfa8ab033550fe2bb710` |
| `packages/steward-agent/README.md` | `e519e9cd28d696a0c800ffce65d25485fb8ca361a8bdbdb6f818ccdcb63f2331` |
| `packages/steward-agent/package.json` | `15bb0dc1f07d4a0662e5cec11186d4ffb0492ed4e06935aacb35b9f85626350d` |

Verify a file: fetch it from vealth.net and compare the hash, or diff it against this repo. Nothing here is a promise of funding, certification or completed work; see docs/truth-boundaries.md.
