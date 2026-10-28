#!/usr/bin/env python3
"""What App Store Connect says about the iPad app: its recent uploads (with any errors) and builds (with their
processing state). Uses the same API key as the upload.  env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (file path)"""
import json, os, sys, time, urllib.request, urllib.error
import jwt  # PyJWT

BUNDLE = 'dev.screenroom.ipad'
key = open(os.environ['ASC_KEY_FILE']).read()
token = jwt.encode({'iss': os.environ['ASC_ISSUER_ID'], 'iat': int(time.time()), 'exp': int(time.time()) + 900, 'aud': 'appstoreconnect-v1'},
                   key, algorithm='ES256', headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})

def get(path):
    req = urllib.request.Request('https://api.appstoreconnect.apple.com' + path, headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {'http_error': e.code, 'body': e.read().decode()[:2000]}

apps = get(f'/v1/apps?filter[bundleId]={BUNDLE}')
print('APP:', json.dumps(apps.get('data', apps), indent=1)[:1500])
if not apps.get('data'):
    print('No app record with bundle ID', BUNDLE, 'was found for this key.'); sys.exit(0)
app = apps['data'][0]['id']
print('\nBUILD UPLOADS:')
print(json.dumps(get(f'/v1/apps/{app}/buildUploads?limit=5'), indent=1)[:6000])
print('\nBUILDS:')
b = get(f'/v1/builds?filter[app]={app}&sort=-uploadedDate&limit=5')
for d in b.get('data', []):
    a = d['attributes']
    print(a.get('version'), a.get('uploadedDate'), a.get('processingState'), 'expired' if a.get('expired') else '')
if 'data' not in b: print(json.dumps(b, indent=1)[:2000])
