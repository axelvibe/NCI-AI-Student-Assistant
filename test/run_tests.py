#!/usr/bin/env python3
"""Run the JavaScriptCore test suites against the local files, or a deployed
site by passing its base URL.

    python3 test/run_tests.py
    python3 test/run_tests.py https://axelvibe.github.io/NCI-AI-Student-Assistant
"""
import json, pathlib, subprocess, sys, tempfile

REPO = str(pathlib.Path(__file__).resolve().parent.parent)
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'

def run(script, base=''):
    src = (pathlib.Path(REPO) / 'test' / script).read_text(encoding='utf-8')
    js = ('var APP_DIR_PLACEHOLDER=%s;\nvar BASE_URL_PLACEHOLDER=%s;\n%s'
          % (json.dumps(REPO + '/'), json.dumps(base or ''), src))
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
        fh.write(js); path = fh.name
    r = subprocess.run([JSC, path], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()

if __name__ == '__main__':
    base = sys.argv[1] if len(sys.argv) > 1 else ''
    label = base or 'local files'
    print('=' * 58)
    print('RUNNING AGAINST: %s' % label)
    print('=' * 58)
    out = run('match_test.js', base)
    print(out)
    if 'Exception' in out:
        sys.exit(1)
