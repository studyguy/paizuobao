# -*- coding: utf-8 -*-
"""
排座宝 P1 本地服务：静态托管 + 事件存储（RSVP/协作） + CP-SAT 云端求解 + NLP 代理钩子

运行：  python serve.py [端口]     （默认 8767）
依赖：  标准库；可选 ortools（有则 /api/solve 走 CP-SAT，无则返回 engine:'none'）
存储：  data/store.json（事件快照 + RSVP 回执）
"""
import json
import os
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

try:
    from ortools.sat.python import cp_model
    HAS_ORTOOLS = True
except ImportError:
    HAS_ORTOOLS = False

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(ROOT, 'data', 'store.json')
STORE_LOCK = threading.Lock()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8767

# ---------------------------------------------------------------- store

def load_store():
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'events': {}}


def save_store(store):
    os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
    tmp = STORE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False)
    os.replace(tmp, STORE_PATH)

# ---------------------------------------------------------------- CP-SAT

# 与前端 solver.js 的 W 权重保持一致
W_HEADMUST, W_VIP, W_UNCLE, W_NONVIP = 60, 25, 22, 8
W_PREFT, W_PREFA, W_GROUP, W_ELDER = 12, 12, 6, 2


def dist_indices(tables):
    """按离主桌距离给桌排序，返回 桌下标 -> 距离序号(0最近)"""
    head = 0
    for i, t in enumerate(tables):
        if t.get('isHead'):
            head = i
            break
    hx = tables[head].get('x', 540)
    hy = tables[head].get('y', 156)
    dists = [((t.get('x', 0) - hx) ** 2 + (t.get('y', 0) - hy) ** 2) ** 0.5 for t in tables]
    order = sorted(range(len(tables)), key=lambda i: dists[i])
    idx = [0] * len(tables)
    for rank, ti in enumerate(order):
        idx[ti] = rank
    return head, idx


def solve_cpsat(payload):
    """返回 {plans:[{assign:[桌下标/宾客], soft:int}], engine:'cpsat'} 或抛异常"""
    guests = payload['guests']
    tables = payload['tables']
    cons = payload.get('constraints', [])
    G, T = len(guests), len(tables)
    if G == 0 or T == 0:
        return {'plans': [], 'engine': 'cpsat'}

    gidx = {g['id']: i for i, g in enumerate(guests)}
    caps = [max(1, int(t.get('capacity', 10))) for t in tables]
    head, distIdx = dist_indices(tables)
    roles = payload.get('roleTable', {})
    rank_of = {rid: r.get('rank', 20) for rid, r in roles.items()}
    head_must_of = {rid: bool(r.get('headMust')) for rid, r in roles.items()}

    ranks = [rank_of.get(g.get('role', ''), 20) for g in guests]
    vips = [ranks[i] >= 85 for i in range(G)]
    uncles = [guests[i].get('role') == 'uncle' for i in range(G)]
    headmust = [head_must_of.get(guests[i].get('role', ''), False) for i in range(G)]

    mustT, mustA, prefT, prefA = [], [], [], []
    for c in cons:
        a, b = gidx.get(c.get('a')), gidx.get(c.get('b'))
        if a is None or b is None:
            continue
        {'mustTogether': mustT, 'mustApart': mustA,
         'preferTogether': prefT, 'preferApart': prefA}.get(c.get('type'), []).append((a, b))

    # 分组（≥3 人）
    groups = {}
    for i, g in enumerate(guests):
        grp = g.get('group', '')
        if grp and grp != '主家':
            groups.setdefault(grp, []).append(i)
    big_groups = [m for m in groups.values() if len(m) >= 3]

    def build_model(diversify_against=None):
        """每轮重建模型；diversify_against 为此前所有解的 assign 列表，
        要求与每一个都至少 15% 宾客不同（保证方案两两有差异）"""
        model = cp_model.CpModel()
        x = {}
        for i in range(G):
            for t in range(T):
                x[i, t] = model.NewBoolVar(f'x{i}_{t}')
        for i in range(G):
            model.AddExactlyOne([x[i, t] for t in range(T)])
        for t in range(T):
            model.Add(sum(x[i, t] for i in range(G)) <= caps[t])

        for a, b in mustT:
            for t in range(T):
                model.Add(x[a, t] == x[b, t])
        for a, b in mustA:
            for t in range(T):
                model.Add(x[a, t] + x[b, t] <= 1)

        obj = []
        for k, (a, b) in enumerate(prefT):
            z = [model.NewBoolVar(f'pt{k}_{t}') for t in range(T)]
            for t in range(T):
                model.Add(z[t] >= x[a, t] - x[b, t])
                model.Add(z[t] >= x[b, t] - x[a, t])
            obj += [W_PREFT * z[t] for t in range(T)]
        for k, (a, b) in enumerate(prefA):
            s = [model.NewBoolVar(f'pa{k}_{t}') for t in range(T)]
            for t in range(T):
                model.Add(s[t] >= x[a, t] + x[b, t] - 1)
            obj += [W_PREFA * s[t] for t in range(T)]

        for i in range(G):
            if headmust[i]:
                obj += [W_HEADMUST * (1 - x[i, head])]
            elif uncles[i]:
                obj += [W_UNCLE * (1 - x[i, head])]
            elif vips[i]:
                obj += [W_VIP * (1 - x[i, head])]
            if ranks[i] < 60:
                obj += [W_NONVIP * x[i, head]]
            elif ranks[i] >= 72:  # 长辈梯度：越远越罚
                obj += [W_ELDER * distIdx[t] * x[i, t] for t in range(T)]

        for k, members in enumerate(big_groups):
            y = [model.NewBoolVar(f'g{k}_{t}') for t in range(T)]
            for t in range(T):
                for m in members:
                    model.AddImplication(x[m, t], y[t])
            obj += [W_GROUP * y[t] for t in range(T)]
            obj.append(-W_GROUP)  # 每组免一次（used-1）

        if diversify_against:
            for pi, prev in enumerate(diversify_against):
                diffs = []
                for i in range(G):
                    d = model.NewBoolVar(f'd{pi}_{i}')
                    model.Add(d == 1 - x[i, prev[i]])
                    diffs.append(d)
                model.Add(sum(diffs) >= max(1, int(G * 0.15)))

        model.Minimize(sum(obj) if obj else 0)
        return model, x

    plans = []
    for p in range(3):
        model, x = build_model([pl['assign'] for pl in plans] or None)
        solver2 = cp_model.CpSolver()
        solver2.parameters.max_time_in_seconds = float(payload.get('timeLimit', 8.0))
        solver2.parameters.num_search_workers = 8
        solver2.parameters.random_seed = p + 1
        status = solver2.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        assign = [next(t for t in range(T) if solver2.Value(x[i, t])) for i in range(G)]
        plans.append({'assign': assign, 'soft': round(solver2.ObjectiveValue())})

    return {'plans': plans, 'engine': 'cpsat'}

# ---------------------------------------------------------------- HTTP

MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.command, fmt % args))

    # ---- helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        rel = unquote(path).lstrip('/\\')  # os.path.join 遇绝对路径会丢弃 ROOT，必须先去头
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_json({'error': 'not_found', 'path': path}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        """必须消费 Content-Length 对应的字节，否则 keep-alive 下残留体会污染下一请求行"""
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n).decode('utf-8')
        try:
            return json.loads(raw)
        except Exception:
            return {'_raw': raw}

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            if path == '/api/health':
                return self.send_json({'engine': 'cpsat' if HAS_ORTOOLS else 'none',
                                       'version': 'p1', 'port': PORT})
            m = re.match(r'^/api/events$', path)
            if m:
                with STORE_LOCK:
                    store = load_store()
                    evts = [{'id': k, 'name': v.get('name', ''),
                             'updatedAt': v.get('updatedAt', 0)}
                            for k, v in store['events'].items()]
                return self.send_json({'events': evts})
            m = re.match(r'^/api/events/([\w-]+)$', path)
            if m:
                with STORE_LOCK:
                    store = load_store()
                    ev = store['events'].get(m.group(1))
                if not ev:
                    return self.send_json({'error': 'event_not_found'}, 404)
                return self.send_json({'id': ev['id'], 'name': ev.get('name', ''),
                                       'state': ev.get('state'), 'rsvps': ev.get('rsvps', {}),
                                       'updatedAt': ev.get('updatedAt', 0)})
            return self.send_file('index.html' if path == '/' else path)
        except Exception as e:
            return self.send_json({'error': 'server_error', 'message': str(e)}, 500)

    # ---- POST ----
    def do_POST(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            body = self.read_body()  # 先消费请求体（keep-alive 必须）
            if path == '/api/solve':
                if not HAS_ORTOOLS:
                    return self.send_json({'engine': 'none', 'plans': [],
                                           'message': '服务端未安装 ortools'}, 503)
                result = solve_cpsat(body)
                return self.send_json(result)

            if path == '/api/nlp':
                # LLM 代理钩子：有 LLM_API_KEY 时转发，否则交给前端规则引擎
                if not os.environ.get('LLM_API_KEY'):
                    return self.send_json({'engine': 'none',
                                           'message': '未配置 LLM_API_KEY，使用前端规则引擎'}, 501)
                return self.send_json({'engine': 'llm', 'message': 'LLM 代理未在本原型实现'}, 501)

            m = re.match(r'^/api/events$', path)
            if m:
                eid = uuid.uuid4().hex[:10]
                ek = uuid.uuid4().hex[:12]
                with STORE_LOCK:
                    store = load_store()
                    store['events'][eid] = {'id': eid, 'name': body.get('name', '未命名'),
                                            'editKey': ek, 'state': body.get('state'),
                                            'rsvps': {}, 'updatedAt': _now()}
                    save_store(store)
                return self.send_json({'id': eid, 'editKey': ek}, 200)

            m = re.match(r'^/api/events/([\w-]+)/rsvp$', path)
            if m:
                eid = m.group(1)
                with STORE_LOCK:
                    store = load_store()
                    ev = store['events'].get(eid)
                    if not ev:
                        return self.send_json({'error': 'event_not_found'}, 404)
                    ev.setdefault('rsvps', {})[body.get('guestId', '')] = {
                        'status': body.get('status', 'yes'),
                        'extra': int(body.get('extra', 0) or 0),
                        'note': body.get('note', ''),
                        'ts': _now(),
                    }
                    save_store(store)
                return self.send_json({'ok': True})
            return self.send_json({'error': 'not_found'}, 404)
        except Exception as e:
            return self.send_json({'error': 'server_error', 'message': str(e)}, 500)

    # ---- PUT ----
    def do_PUT(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            body = self.read_body()  # 先消费请求体
            m = re.match(r'^/api/events/([\w-]+)$', path)
            if m:
                eid = m.group(1)
                key = (q.get('k') or [''])[0]
                with STORE_LOCK:
                    store = load_store()
                    ev = store['events'].get(eid)
                    if not ev:
                        return self.send_json({'error': 'event_not_found'}, 404)
                    if ev.get('editKey') != key:
                        return self.send_json({'error': 'forbidden',
                                               'message': '编辑密钥不符（只读链接）'}, 403)
                    ev['state'] = body.get('state')
                    ev['updatedAt'] = _now()
                    save_store(store)
                return self.send_json({'ok': True, 'updatedAt': ev['updatedAt']})
            return self.send_json({'error': 'not_found'}, 404)
        except Exception as e:
            return self.send_json({'error': 'server_error', 'message': str(e)}, 500)


def _now():
    import time
    return int(time.time())


def main():
    os.chdir(ROOT)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('排座宝 P1 服务已启动: http://127.0.0.1:%d/  引擎: %s'
          % (PORT, 'CP-SAT' if HAS_ORTOOLS else '无 ortools（求解走前端）'))
    srv.serve_forever()


if __name__ == '__main__':
    main()
