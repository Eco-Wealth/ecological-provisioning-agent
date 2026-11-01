# Synthetic example

Everything here is made up: the people, the site, the credential and the photos (text files stand in for images). The fingerprints are real, so the checker can verify them.

```
node packages/hrsr-validate/hrsr-validate.mjs examples/human-reviewed-ai-safety-report/sample-report.json --level L2 --files examples/human-reviewed-ai-safety-report
```

It reaches L2 and not L3, because nothing was anchored.
