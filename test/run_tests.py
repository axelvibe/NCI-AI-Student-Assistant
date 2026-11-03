#!/usr/bin/env python3
"""Run the JavaScriptCore test suites against the local files, or a deployed
site by passing its base URL.

    python3 test/run_tests.py
    python3 test/run_tests.py https://axelvibe.github.io/NCI-AI-Student-Assistant

For a deployed site the runner downloads app.js and knowledge.json first, so
the test exercises exactly the files that are live.
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, urllib.request

REPO = str(pathlib.Path(__file__).resolve().parent.parent)
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'

def download_site(base):
    base = base.rstrip('/')
    tmp = tempfile.mkdtemp(prefix='nci-live-test-')
    for name in ('app.js', 'knowledge.json'):
        urllib.request.urlretrieve(base + '/' + name, os.path.join(tmp, name))
    os.makedirs(os.path.join(tmp, 'test'))
    shutil.copy(os.path.join(REPO, 'test', 'cases.json'),
                os.path.join(tmp, 'test', 'cases.json'))
    return tmp + '/'

def run(script, app_dir, base=''):
    src = (pathlib.Path(REPO) / 'test' / script).read_text(encoding='utf-8')
    js = ('var APP_DIR_PLACEHOLDER=%s;\nvar BASE_URL_PLACEHOLDER=%s;\n%s'
          % (json.dumps(app_dir), json.dumps(base or ''), src))
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
        fh.write(js); path = fh.name
    r = subprocess.run([JSC, path], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()

if __name__ == '__main__':
    base = sys.argv[1] if len(sys.argv) > 1 else ''
    label = base or 'local files'
    app_dir = download_site(base) if base else (REPO + '/')
    print('=' * 58)
    print('RUNNING AGAINST: %s' % label)
    print('=' * 58)
    out = run('match_test.js', app_dir, base)
    print(out)
    failed = 'Exception' in out

    print('')
    print('-' * 58)
    print('LOGGING CONTRACT (Proxy.gs)')
    print('-' * 58)
    out2 = run('proxy_log_test.js', REPO + '/')
    print(out2)
    failed = failed or 'Exception' in out2
    sys.exit(1 if failed else 0)
