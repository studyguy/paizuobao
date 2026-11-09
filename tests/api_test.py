# -*- coding: utf-8 -*-
"""排座宝 P1 服务端 API 测试：需先启动 python serve.py 8767"""
import json
import sys
import urllib.request
import urllib.error

sys.stdout.reconfigure(encoding='utf-8')

BASE = 'http://127.0.0.1:8767'
passed = failed = 0


def ok(cond, name, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print('  [PASS] ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + (' — ' + json.dumps(extra, ensure_ascii=False)[:200] if extra is not None else ''))


def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, data, timeout=30) as resp:
            raw = resp.read().decode('utf-8')
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, {'_raw': raw[:80], '_ctype': resp.headers.get('Content-Type', '')}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {}


def demo_payload():
    return {
        'guests': [
            {'id': 'g1', 'name': '张伟', 'side': 'groom', 'role': 'groom', 'group': ''},
            {'id': 'g2', 'name': '林晓', 'side': 'bride', 'role': 'bride', 'group': ''},
            {'id': 'g3', 'name': '张国栋', 'side': 'groom', 'role': 'groomFather', 'group': ''},
            {'id': 'g4', 'name': '王秀兰', 'side': 'groom', 'role': 'groomMother', 'group': ''},
            {'id': 'g5', 'name': '王总', 'side': 'groom', 'role': 'leader', 'group': '领导'},
            {'id': 'g6', 'name': '李总', 'side': 'groom', 'role': 'leader', 'group': '领导'},
            {'id': 'g7', 'name': '同事甲', 'side': 'groom', 'role': 'colleague', 'group': '同事'},
            {'id': 'g8', 'name': '同事乙', 'side': 'groom', 'role': 'colleague', 'group': '同事'},
            {'id': 'g9', 'name': '朋友甲', 'side': 'bride', 'role': 'friend', 'group': ''},
            {'id': 'g10', 'name': '朋友乙', 'side': 'bride', 'role': 'friend', 'group': ''},
        ],
        'tables': [
            {'id': 't1', 'capacity': 10, 'isHead': True, 'x': 540, 'y': 156},
            {'id': 't2', 'capacity': 10, 'isHead': False, 'x': 200, 'y': 400},
        ],
        'constraints': [
            {'type': 'mustApart', 'a': 'g5', 'b': 'g6'},
            {'type': 'mustTogether', 'a': 'g3', 'b': 'g4'},
        ],
        'roleTable': {},
        'timeLimit': 6,
    }


print('[health]')
st, health = req('GET', '/api/health')
ok(st == 200, 'health 200', health)
ok(health.get('engine') in ('cpsat', 'none'), 'engine 字段', health)

print('[solve]')
st, res = req('POST', '/api/solve', demo_payload())
if health.get('engine') == 'cpsat':
    ok(st == 200, 'solve 200', res)
    ok(res.get('engine') == 'cpsat', '引擎标记 cpsat')
    ok(len(res.get('plans', [])) == 3, '3 套方案（实际 %d）' % len(res.get('plans', [])))
    p0 = res['plans'][0]
    assign = p0['assign']
    # g5 g6 不同桌
    ok(assign[4] != assign[5], 'CP-SAT：王总李总不同桌', assign)
    # g3 g4 同桌
    ok(assign[2] == assign[3], 'CP-SAT：父母同桌', assign)
    # 三套方案互不相同
    plans = res['plans']
    distinct = len({tuple(p['assign']) for p in plans})
    ok(distinct == len(plans), '方案两两不同（%d/%d）' % (distinct, len(plans)))
else:
    ok(st == 503, '无 ortools 时 solve 503（降级契约）', (st, res))

print('[events / rsvp / collab]')
st, ev = req('POST', '/api/events', {'name': '测试婚宴', 'state': {'meta': {'eventName': '测试婚宴'}, 'guests': []}})
ok(st == 200 and ev.get('id') and ev.get('editKey'), '创建事件', ev)
eid, ek = ev['id'], ev['editKey']

st, got = req('GET', '/api/events/' + eid)
ok(st == 200 and got.get('name') == '测试婚宴', '读取事件', got.get('name'))

st, r = req('POST', '/api/events/%s/rsvp' % eid, {'guestId': 'g1', 'status': 'yes', 'extra': 1, 'note': '一定到'})
ok(st == 200 and r.get('ok'), 'RSVP 回执写入', r)
st, got = req('GET', '/api/events/' + eid)
ok(got.get('rsvps', {}).get('g1', {}).get('extra') == 1, 'RSVP 读回')

st, r = req('PUT', '/api/events/%s?k=%s' % (eid, ek), {'state': {'meta': {'eventName': '测试婚宴v2'}, 'guests': [1]}})
ok(st == 200 and r.get('ok'), '协作保存（带密钥）', r)
st, got = req('GET', '/api/events/' + eid)
ok(got['state']['meta']['eventName'] == '测试婚宴v2', '协作保存读回')

st, r = req('PUT', '/api/events/%s?k=wrong' % eid, {'state': {'meta': {}}})
ok(st == 403, '错误密钥 403（只读保护）', (st, r))

st, r = req('GET', '/api/events/nonexistent00')
ok(st == 404, '不存在的事件 404')

st, r = req('GET', '/rsvp.html')
ok(st == 200, 'rsvp.html 可访问')
st, r = req('GET', '/cards.html')
ok(st == 200, 'cards.html 可访问')
st, r = req('GET', '/screen.html')
ok(st == 200, 'screen.html 可访问')
st, r = req('GET', '/')
ok(st == 200 and r.get('_ctype', '').startswith('text/html'), 'index.html 可访问')

print('\n========================================')
print('通过 %d / 失败 %d' % (passed, failed))
sys.exit(1 if failed else 0)
