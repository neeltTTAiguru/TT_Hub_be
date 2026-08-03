#!/usr/bin/env python3
import json
import os
import urllib.request
import urllib.parse
import yaml
import time
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

HOME = os.environ.get('HUBSPOT_HOME', '/opt/data')
DEAL_COLUMNS = [
    'Deal Name','Deal Stage','Presentation/Demo Completed','Trial / Quote Requested','Date Trial Agreement Sent',
    'Trial Agreement Executed','Date Trial Started','Date Trial Ends','Trial Outcome','Date Quote Sent',
    'Date Purchase Order Received','Purchase Order Amount','Date MSA Sent','MSA Executed?','Term of the MSA',
    'Payment Cycle','Number of Cameras Purchased','MSA Renewal Date','Redaction Amount','Term, Payment, Rate',
    'Close Date','Number of Calls','Number of Emails','Connected Over Call?','Connected Over Email?',
    'Qualified Lead?','Meeting Status','Handed Off To SAE?','Deal Owner','SDR Deal Owner','Amount','Description'
]

def mcp_call(url, token, body, session=None):
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if session: headers['Mcp-Session-Id'] = session
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read()
        return response.headers, json.loads(raw) if raw else {}

def read_deals():
    config = yaml.safe_load(open(f'{HOME}/config.yaml'))
    url = config['mcp_servers']['hubspot']['url']
    token_path = f'{HOME}/mcp-tokens/hubspot.json'
    token_data = json.load(open(token_path))
    if float(token_data.get('expires_at', 0)) <= time.time() + 30:
        client = json.load(open(f'{HOME}/mcp-tokens/hubspot.client.json'))
        meta = json.load(open(f'{HOME}/mcp-tokens/hubspot.meta.json'))
        payload = urllib.parse.urlencode({'grant_type':'refresh_token','refresh_token':token_data['refresh_token'],'client_id':client['client_id'],'client_secret':client['client_secret']}).encode()
        with urllib.request.urlopen(urllib.request.Request(meta['token_endpoint'], data=payload, method='POST'), timeout=20) as response:
            refreshed = json.load(response)
        refreshed['refresh_token'] = refreshed.get('refresh_token', token_data['refresh_token'])
        refreshed['expires_at'] = time.time() + float(refreshed.get('expires_in', 1800))
        with open(token_path, 'w') as handle: json.dump(refreshed, handle)
        token_data = refreshed
    token = token_data['access_token']
    headers, _ = mcp_call(url, token, {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'trusted-tech-deals','version':'1.0'}}})
    session = headers['mcp-session-id']
    mcp_call(url, token, {'jsonrpc':'2.0','method':'notifications/initialized','params':{}}, session)
    _, metadata = mcp_call(url, token, {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'get_properties','arguments':{'objectType':'deals','propertyNames':['dealstage','pipeline']}}}, session)
    _, all_metadata = mcp_call(url, token, {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'search_properties','arguments':{'objectType':'deals'}}}, session)
    def content_json(payload):
        text = (payload.get('result', {}).get('content') or [{}])[0].get('text', '{}')
        try: return json.loads(text)
        except Exception: return {}
    metadata_json = content_json(metadata)
    all_metadata_json = content_json(all_metadata)
    definitions = {item.get('name'): item for item in metadata_json.get('results', [])}
    normalize_label = lambda value: re.sub(r'[^a-z0-9]+', '', str(value).lower())
    definitions_by_label = {normalize_label(item.get('label','')): item for item in all_metadata_json.get('results', [])}
    stage_labels = {str(option.get('value')): str(option.get('label')) for option in definitions.get('dealstage', {}).get('options', [])}
    pipeline_labels = {str(option.get('value')): str(option.get('label')) for option in definitions.get('pipeline', {}).get('options', [])}
    primary_pipeline_id = next((value for value, label in pipeline_labels.items() if label.strip().lower() == 'deal pipeline'), None)
    if not primary_pipeline_id: raise RuntimeError('Deal Pipeline was not found in HubSpot metadata.')
    selected = {}
    for label in DEAL_COLUMNS:
        definition = definitions_by_label.get(normalize_label(label))
        if definition and definition.get('name'): selected[definition['name']] = label
    for internal, label in [('dealname','Deal Name'),('dealstage','Deal Stage'),('hubspot_owner_id','Deal Owner'),('amount','Amount'),('closedate','Close Date'),('description','Description')]:
        selected.setdefault(internal, label)
    all_items, offset, total = [], None, None
    while True:
        arguments = {'objectType':'deals','properties':list(selected.keys()),'filterGroups':[{'filters':[{'propertyName':'pipeline','operator':'EQ','value':primary_pipeline_id}]}],'sorts':[{'propertyName':'closedate','direction':'DESCENDING'}],'limit':200,'chatInsights':{'userIntent':'Review deal pipeline','satisfaction':'NEUTRAL'}}
        if offset is not None: arguments['offset'] = offset
        _, page_result = mcp_call(url, token, {'jsonrpc':'2.0','id':10 + len(all_items),'method':'tools/call','params':{'name':'search_crm_objects','arguments':arguments}}, session)
        page = content_json(page_result)
        all_items.extend(page.get('results', []))
        total = page.get('total', total)
        offset = page.get('offset')
        if offset is None or len(all_items) >= int(total or 0): break
    owner_fields = [name for name, label in selected.items() if 'owner' in label.lower()]
    owner_ids = sorted({int(item.get('properties', {}).get(field)) for item in all_items for field in owner_fields if str(item.get('properties', {}).get(field, '')).isdigit()})
    owner_names = {}
    for index in range(0, len(owner_ids), 100):
        _, owner_result = mcp_call(url, token, {'jsonrpc':'2.0','id':1000 + index,'method':'tools/call','params':{'name':'search_owners','arguments':{'ownerIds':owner_ids[index:index+100],'limit':100}}}, session)
        owner_json = content_json(owner_result)
        for owner in owner_json.get('results', owner_json.get('owners', [])):
            owner_id = str(owner.get('id', owner.get('ownerId', '')))
            name = str(owner.get('name') or '').strip() or ' '.join(str(value).strip() for value in [owner.get('firstName'), owner.get('lastName')] if value).strip()
            owner_names[owner_id] = name or owner.get('email') or 'Unassigned'
    deals = []
    for item in all_items:
        props = item.get('properties', {})
        deal = {}
        for internal, label in selected.items():
            value = props.get(internal)
            if internal == 'dealstage': value = stage_labels.get(str(value), 'Unknown')
            elif internal in owner_fields: value = owner_names.get(str(value), 'Unassigned')
            deal[label] = value if value not in ('', None) else None
        deals.append(deal)
    primary_deals = deals
    won = [deal for deal in primary_deals if str(deal.get('Deal Stage', '')).strip().lower() == 'closed won']
    return {'available_columns':list(selected.values()),'summary':{'pipeline':'Deal Pipeline','total_deals':len(primary_deals),'closed_won_deals':len(won)},'deals':primary_deals}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/deals': self.send_error(404); return
        try:
            body = json.dumps(read_deals()).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as error:
            body = json.dumps({'message': str(error)}).encode()
            self.send_response(502); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

HTTPServer(('127.0.0.1', 8650), Handler).serve_forever()
