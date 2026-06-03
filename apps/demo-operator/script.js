const run = document.getElementById('run');
const intent = document.getElementById('intent');
const output = document.getElementById('output');

run.addEventListener('click', () => {
  const text = intent.value;
  const demo = {
    intent: {
      summary: text,
      place: 'example site',
      unknowns: ['exact site conditions', 'permissions', 'hazards'],
      proof_needed: ['before photos', 'after photos', 'remaining risks']
    },
    lenses: ['place', 'water', 'health', 'equity', 'beauty', 'proof'].map((lens) => ({
      lens,
      alignment: 'unknown or partial',
      evidence_needed: ['before state', 'after state', 'observer notes']
    })),
    route: {
      primary_category: 'documentation',
      next_action: 'Create a bounded first-pass packet with human review.'
    },
    truth_boundary: 'Demo only. No certification, dispatch, payment, deployment, public posting, or verified outcome.'
  };
  output.textContent = JSON.stringify(demo, null, 2);
});

run.click();
