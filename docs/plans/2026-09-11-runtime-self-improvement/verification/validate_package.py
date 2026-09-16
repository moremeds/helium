"""Package-only validation; never changes implementation check statuses."""
from pathlib import Path
import copy
import json
import re
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


def main():
    for p in ROOT.rglob('*.json'):
        json.loads(p.read_text(encoding='utf-8'))
    schema = load('contracts/runtime-config-v1.schema.json')
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    baseline = load('examples/premarket-baseline.json')
    candidate = load('examples/premarket-candidate.json')
    validator.validate(baseline)
    validator.validate(candidate)
    expected = copy.deepcopy(baseline)
    expected['config']['news']['perStock'] = 3
    assert expected == candidate
    for value in (0, 4, True, '3'):
        invalid = copy.deepcopy(baseline)
        invalid['config']['news']['perStock'] = value
        assert list(validator.iter_errors(invalid)), value
    for key in ('cmd', 'permissions', '__proto__'):
        invalid = copy.deepcopy(baseline)
        invalid[key] = 'forbidden'
        assert list(validator.iter_errors(invalid)), key
    checks = load('verification/checks.json')
    ids = [c['id'] for c in checks['checks']]
    assert len(ids) == len(set(ids)) == checks['checkCount'] == 105
    assert sum(x.startswith('A-') for x in ids) == 22
    assert all(c['status'] == 'NOT_RUN' for c in checks['checks'])
    assert all(c['deliveryWave'] in {'M1', 'M2', 'M3', 'EXTENSION'} and c['applicability'] for c in checks['checks'])
    mapping = load('verification/legacy-mapping.json')['mappings']
    assert len(mapping) == len({x['legacyId'] for x in mapping}) == 77
    assert all(set(x['mappedTo']) <= set(ids) for x in mapping)
    grant = load('examples/automation-grant.template.json')
    assert grant['enabled'] is False and grant['grantId'] is None
    assert grant['action'] == 'AUTO_ACTIVATE'
    pilot = load('examples/pilot-experiment.template.json')
    assert pilot['activationMode'] == 'MANUAL_REVIEW_ONLY'
    assert pilot['evaluation']['criticalErrorsMaximum'] == 0
    assert pilot['evaluation']['sampleSizeRationale'] is None
    assert pilot['resourcePolicy']['costIncreaseLimit'] is None
    assert pilot['status'] == 'DRAFT_NOT_EXECUTABLE'
    assert pilot['executionContext']['environment'] == 'evaluation'
    assert pilot['executionContext']['deliveryMode'] == 'disabled'
    assert pilot['targetDeployment']['environment'] == 'test'
    assert pilot['targetDeployment']['expectedRevision'] is None
    for path in ROOT.rglob('*.md'):
        text = path.read_text(encoding='utf-8')
        assert sum(line.startswith('```') for line in text.splitlines()) % 2 == 0, path
        for target in re.findall(r'\]\(([^)]+)\)', text):
            if '://' not in target and not target.startswith('#'):
                assert (path.parent / target.split('#')[0]).exists(), (path, target)
    print(json.dumps({'scope': 'PACKAGE_STATIC_ONLY', 'result': 'PASS',
        'implementationChecks': 105, 'allImplementationChecks': 'NOT_RUN',
        'legacyMappings': 77, 'databaseTestsExecuted': False,
        'heliumTestsExecuted': False, 'productionTestsExecuted': False}))


if __name__ == '__main__':
    main()
