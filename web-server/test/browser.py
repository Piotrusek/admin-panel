#!/usr/bin/env python3
"""Production UI regression tests via ChromeDriver's W3C protocol; no Python packages needed."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

origin = sys.argv[1]
discord_mode = len(sys.argv) > 2 and sys.argv[2] == "discord"
driver = shutil.which('chromedriver')
if not driver:
    raise SystemExit('Install Chromium and matching chromedriver to run webTest (required by gradle build).')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
session = None
checks = 0

def request(method, path, body=None):
    payload = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=payload, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.load(response).get('value')
    except urllib.error.HTTPError as error:
        raise AssertionError(error.read().decode()) from error
    if isinstance(result, dict) and result.get('error'):
        raise AssertionError(result)
    return result

def command(path, body):
    return request('POST', '/session/' + session + path, body)

def js(script, *args):
    return command('/execute/sync', {'script': script, 'args': list(args)})

def wait(expression):
    end = time.monotonic() + 8
    while time.monotonic() < end:
        if js('return ' + expression):
            return
        time.sleep(.08)
    raise AssertionError('Timed out: ' + expression)

def element(selector):
    result = command('/element', {'using': 'css selector', 'value': selector})
    return result['element-6066-11e4-a52e-4f735466cecf']

def click(selector):
    command('/element/' + element(selector) + '/click', {})

def fill(selector, text):
    path = '/element/' + element(selector)
    command(path + '/value', {'text': '\ue009a\ue000\ue003' + text})

def check(expression, message):
    global checks
    if not js('return ' + expression):
        raise AssertionError(message)
    checks += 1


def login(user):
    fill('[name=username]',user)
    fill('[name=password]','browser-test-password')
    click('#login-form button')
    wait("!!document.querySelector('#app') && document.querySelectorAll('.player-row').length===2")

def text_click(text):
    js("const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(arguments[0])); if(!b) throw Error('Missing button '+arguments[0]); b.click()",text)

with tempfile.TemporaryDirectory(prefix='react-browser-') as profile:
    reports=pathlib.Path('../build/reports/react-browser')
    reports.mkdir(parents=True,exist_ok=True)
    process=subprocess.Popen([driver,f'--port={port}','--allowed-ips=127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                request('GET','/status')
                break
            except OSError:
                time.sleep(.05)
        options=['--headless=new','--disable-dev-shm-usage','--window-size=1440,1000','--user-data-dir='+profile]
        if os.environ.get('PANEL_TEST_NO_SANDBOX')=='1':options.append('--no-sandbox')
        result=request('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'chrome','goog:chromeOptions':{'args':options},'goog:loggingPrefs':{'browser':'ALL'}}}})
        session=result['sessionId']
        command('/url',{'url':origin})
        if discord_mode:
            command('/cookie',{'cookie':{'name':'panel_session','value':os.environ['PANEL_TEST_SESSION'],'path':'/'}})
            command('/refresh',{})
            wait("!!document.querySelector('#access-nav') && !!document.querySelector('[aria-label=\"Rank 1 name\"]')")
            check("![...document.querySelectorAll('.nav-button')].some(b=>b.textContent.includes('Players')||b.textContent.includes('Audit'))",'manager without player or audit grants sees only rank management')
            click('tbody tr:first-child details summary')
            check("document.querySelectorAll('tbody tr:first-child input[data-permission]').length===38",'all explicit permissions editable')
            click('tbody tr:first-child input[data-permission="notes.edit"]')
            text_click('Save changes')
            command('/alert/accept',{})
            wait("document.querySelector('.notice').textContent.includes('Saved. Restart')")
            checks+=1
            print(f'PASS: {checks} React rank permission editor checks.')
            raise SystemExit(0)
        wait("!!document.querySelector('#login-form')")
        js("Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true})")
        login('admin')
        click('#todo-nav')
        wait("!!document.querySelector('#todo-board .todo-columns')")
        text_click('New task')
        fill('[aria-label="Task title"]','Repair spawn lifts')
        fill('[aria-label="Task assignee"]','Developer')
        text_click('Save task')
        wait("!!document.querySelector('.todo-task') && !document.querySelector('.task-editor')")
        text_click('Edit task')
        js("const s=document.querySelector('[aria-label=\"Task status\"]');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(s,'doing');s.dispatchEvent(new Event('change',{bubbles:true}))")
        text_click('Save task')
        wait("document.querySelectorAll('.todo-column')[1].textContent.includes('Repair spawn lifts')")
        js("const card=document.querySelector('.todo-task');const target=document.querySelector('.todo-column[data-status=done]');const transfer=new DataTransfer();card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));card.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));")
        wait("document.querySelector('.todo-column[data-status=done]').textContent.includes('Repair spawn lifts')")
        text_click('Refresh tasks')
        wait("document.querySelector('.todo-column[data-status=done]').textContent.includes('Repair spawn lifts')")
        checks+=1
        click('#suggestions-nav')
        wait("!!document.querySelector('.suggestion-card')")
        js("window.suggestionFetches=0;const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).startsWith('/api/suggestions?'))window.suggestionFetches++;return original(...args)}")
        js("[...document.querySelectorAll('.suggestion-filter-tags button')].find(b=>b.textContent==='In review').click()")
        check("!!document.querySelector('.suggestion-card') && !!document.querySelector('.suggestion-filter-tags') && document.querySelector('#suggestions').getAttribute('aria-busy')==='true'",'old suggestions and filters remain visible during a delayed request')
        wait("document.querySelector('#suggestions').textContent.includes('No suggestions match the selected filters.')")
        text_click('Clear filters')
        wait("!!document.querySelector('.suggestion-card')")
        check("window.suggestionFetches===1 && document.querySelector('#suggestions').getAttribute('aria-busy')==='false'",'returning to cached filters avoids another request')
        text_click('No tags')
        wait("document.querySelector('#suggestions').textContent.includes('No suggestions match the selected filters.')")
        check("[...document.querySelectorAll('.suggestion-filter-tags button')].find(b=>b.textContent==='No tags').getAttribute('aria-pressed')==='true'",'untagged filter selected')
        text_click('Clear filters')
        wait("!!document.querySelector('.suggestion-card')")
        check("getComputedStyle(document.querySelector('.suggestion-card strong')).fontSize==='12px'",'compact suggestion text')
        click('.suggestion-card')
        wait("document.querySelector('.ticket-messages').textContent.includes('A station would help')")
        fill('#ticket-reply','Thanks for suggesting this station.')
        click('.ticket-composer button.primary')
        wait("document.querySelector('.ticket-send-status').textContent.includes('Reply sent')")
        check("document.querySelector('.ticket-messages').textContent.includes('Thanks for suggesting this station.')",'suggestion reply displayed')
        click('.suggestion-tag-options label:first-child input')
        click('.suggestion-tag-options label:nth-child(2) input')
        text_click('Save tags')
        wait("document.querySelector('#suggestions').textContent.includes('Forum tags updated')")
        check("document.querySelector('.suggestion-card .ticket-tags').textContent==='In review'",'suggestion tag edit reflected in list')
        text_click('Create task')
        wait("document.querySelector('#suggestions').textContent.includes('Task created')")
        click('#todo-nav')
        wait("document.querySelector('#todo-board').textContent.includes('Build a spawn station')")
        check("!!document.querySelector('.task-source')",'suggestion creates linked developer task')
        click('#tickets-nav')
        wait("!!document.querySelector('#tickets .filter-tabs')")
        check("document.querySelectorAll('#tickets .filter-tabs button').length===8",'all ticket categories visible to admin')
        check("document.querySelector('#tickets').textContent.includes('lost-items-or-airship-1619') && document.querySelector('#tickets').textContent.includes('Open <review>')",'ticket names and tags render safely')
        check("document.querySelector('#tickets a').href==='https://discord.com/channels/12345678901234568/12345678901234567'",'ticket links open correct Discord channel')
        click('.ticket-list-row button')
        wait("document.querySelector('.ticket-messages').textContent.includes('I lost my airship')")
        check("document.querySelector('.ticket-messages').textContent.includes('<script>alert(1)</script>') && !document.querySelector('.ticket-messages script')",'ticket message text is escaped')
        fill('#ticket-reply','We can help recover your airship.')
        click('.ticket-composer button.primary')
        wait("document.querySelector('.ticket-send-status').textContent.includes('Reply sent')")
        check("document.querySelector('.ticket-messages').textContent.includes('We can help recover your airship.') && document.querySelector('#ticket-reply').value===''",'reply appears in conversation and clears draft')
        import base64
        (reports/'tickets-desktop.png').write_bytes(base64.b64decode(request('GET','/session/'+session+'/screenshot')))
        command('/window/rect',{'width':390,'height':850})
        check("document.documentElement.scrollWidth<=window.innerWidth",'ticket conversation fits mobile')
        (reports/'tickets-mobile.png').write_bytes(base64.b64decode(request('GET','/session/'+session+'/screenshot')))
        command('/window/rect',{'width':1440,'height':1000})
        text_click('Other Support')
        wait("document.querySelector('#tickets').textContent.includes('No tickets in this category')")
        text_click('Players')
        fill('#search','nobody')
        wait("document.querySelectorAll('.player-row').length===0")
        check("document.querySelector('#player-rows').textContent.includes('No players found')",'empty search')
        fill('#search','')
        click('[data-filter=offline]')
        wait("document.querySelectorAll('.player-row').length===1")
        check("document.querySelector('.player-row').textContent.includes('OfflinePlayer')",'offline filter')
        click('[data-filter=online]')
        click('.player-row')
        wait("!!document.querySelector('[data-tab=notes]')")
        check("document.querySelector('#detail').textContent.includes('minecraft:overworld')",'location preserved')
        wait("document.querySelector('#detail').textContent.includes('321.0')")
        checks+=1
        click('[data-tab=security]')
        check("document.querySelector('#detail').textContent.includes('<img src=x') && !window.xss",'security escapes stored data')
        click('[data-tab=inventory]')
        wait("!!document.querySelector('.item-slot')")
        check("document.querySelector('.item-slot').textContent.includes('<img src=x') && !window.xss",'inventory escapes item name')
        check("document.querySelector('.item-slot').textContent.includes('99')",'inventory receives live changes')
        click('.item-slot summary')
        check("document.querySelector('.item-slot[open]').textContent.includes('Unbreaking 3')",'item details preserved')
        click('[data-tab=notes]')
        text_click('Add staff note')
        wait("document.querySelector('#action-dialog')?.open")
        fill('[name=text]','React test note')
        click('#action-form input[type=checkbox]')
        click('#action-form button[type=submit]')
        wait("!document.querySelector('#action-dialog') && document.querySelector('#detail').textContent.includes('React test note')")
        checks+=1
        text_click('Edit')
        wait("document.querySelector('#action-dialog')?.open")
        fill('[name=text]','Edited React note')
        click('#action-form input[type=checkbox]')
        click('#action-form button[type=submit]')
        wait("!document.querySelector('#action-dialog') && document.querySelector('#detail').textContent.includes('Edited React note')")
        checks+=1
        text_click('Issue punishment')
        wait("document.querySelector('#action-dialog')?.open")
        js("const select=document.querySelector('[name=type]');select.value='WARN';select.dispatchEvent(new Event('change',{bubbles:true}))")
        fill('[name=reason]','React warning')
        click('#action-form input[type=checkbox][required]')
        click('#action-form button[type=submit]')
        wait("!document.querySelector('#action-dialog')")
        click('[data-tab=cases]')
        wait("document.querySelector('#detail').textContent.includes('React warning')")
        checks+=1
        text_click('Remove punishment')
        wait("document.querySelector('#action-dialog')?.open")
        fill('[name=reason]','Reviewed warning removal')
        click('#action-form input[type=checkbox][required]')
        click('#action-form button[type=submit]')
        wait("!document.querySelector('#action-dialog') && document.querySelector('#detail').textContent.includes('Removed by admin')")
        check("![...document.querySelectorAll('#detail button')].some(b=>b.textContent.includes('Remove punishment'))",'removed punishment cannot be removed again')
        click('#audit-nav')
        wait("!!document.querySelector('table') && document.querySelector('table').textContent.includes('punish')")
        checks+=1
        text_click('Players')
        command('/window/rect',{'width':390,'height':850})
        check("document.documentElement.scrollWidth<=window.innerWidth",'mobile layout fits')
        click('#logout')
        wait("!!document.querySelector('#login-form')")
        login('viewer')
        click('[data-filter=online]')
        click('.player-row')
        wait("!!document.querySelector('[data-tab=notes]')")
        check("!document.querySelector('#tickets-nav') && !document.querySelector('#audit-nav') && ![...document.querySelectorAll('button')].some(b=>b.textContent.includes('Issue punishment'))",'viewer controls restricted')
        click('[data-tab=notes]')
        check("![...document.querySelectorAll('button')].some(b=>b.textContent.includes('Add staff note'))",'viewer notes read-only')
        click('#logout')
        wait("!!document.querySelector('#login-form')")
        login('moderator')
        click('.player-row')
        wait("!!document.querySelector('[data-tab=notes]')")
        check("document.querySelectorAll('[data-tab]').length===1 && document.querySelector('[data-tab]').dataset.tab==='notes'",'granular rank sees only notes tab')
        check("![...document.querySelectorAll('button')].some(b=>b.textContent.includes('Add staff note')||b.textContent.includes('Issue punishment')||b.textContent==='Remove')",'editing grant does not allow adding, removing, or punishing')
        errors=command('/log' ,{'type':'browser'})
        severe=[e for e in errors if e['level']=='SEVERE' and ('javascript' in e.get('source','') or 'Uncaught' in e['message'])]
        if severe:raise AssertionError(severe)
        checks+=1
        print(f'PASS: {checks} React browser checks (login, filters, profiles, notes, punishments, audit, XSS, mobile and viewer access).')
    except Exception:
        if session:
            import base64
            (reports/'failure.png').write_bytes(base64.b64decode(request('GET','/session/'+session+'/screenshot')))
            (reports/'failure.html').write_text(js('return document.documentElement.outerHTML'))
        raise
    finally:
        try:
            if session:request('DELETE','/session/'+session)
        finally:
            process.terminate()
            process.wait(timeout=10)
