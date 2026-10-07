"""Select an explicit initial or repaired qualification, without inferring run status."""
import json
import os

def value(name):
    return json.loads(os.environ['INPUTS_' + name.upper()])

initial = value('initial')
retry = value('retried')
candidate = value('candidate')
if initial['repair']:
    candidate = value('repaired')
    result = retry
else:
    result = initial
ready = bool(result and candidate and result['ready'] and candidate['delivered'])
print(json.dumps({'ready': ready, 'prs': candidate['prs'] if ready else [],
                  'evidence': result['evidence'] if result else initial['evidence']}))
