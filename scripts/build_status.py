"""Repository build tracker. Standard-library Python 3; no application dependencies."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'status/build-status.json'
SNAPSHOT = ROOT / 'status/build-status-data.js'
STATES = ('not_started', 'in_progress', 'blocked', 'in_review', 'done')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def load():
    contracts = ROOT / 'docs/development/contracts'
    plan = read(contracts / 'release-plan.json')
    tickets = read(contracts / 'backlog.json')['tickets']
    state = read(STATE) if STATE.exists() else {'version': 1, 'tickets': {}, 'releases': {}, 'history': []}
    known = {t['id'] for t in tickets}
    releases = {r['id'] for r in plan['releases']}
    if set(state['tickets']) - known or set(state['releases']) - releases:
        raise ValueError('Tracked IDs were removed from the plan; migrate their history before syncing.')
    for t in tickets:
        state['tickets'].setdefault(t['id'], {'status': 'not_started', 'owner': '', 'note': '', 'evidence': '', 'updated_at': None})
    for r in plan['releases']:
        state['releases'].setdefault(r['id'], {'released_at': None, 'evidence': ''})
    for value in state['tickets'].values():
        if value['status'] not in STATES:
            raise ValueError('Invalid ticket status')
        if value['status'] == 'done' and not value['evidence'].strip():
            raise ValueError('Done tickets require evidence')
    for r in plan['releases']:
        release = state['releases'][r['id']]
        if release['released_at']:
            if not release['evidence'].strip() or any(state['tickets'][t['id']]['status'] != 'done' for t in tickets if t['phase'] == r['id']):
                raise ValueError('Released increments require all tickets done and gate evidence')
            if any(not state['releases'][dep]['released_at'] for dep in r['depends_on']):
                raise ValueError('Released increment has an unreleased dependency')
    return state, plan, tickets


def payload(state, plan, tickets):
    return {'version': 1, 'updated_at': state['updated_at'], 'releases': [
        {**r, **state['releases'][r['id']], 'spec': r['spec'].replace('\\', '/')} for r in plan['releases']],
        'tickets': [{**t, 'spec_status': t['status'], **state['tickets'][t['id']], 'spec': t['spec'].replace('\\', '/')} for t in tickets],
        'history': state['history'][-30:]}


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(value, encoding='utf-8')
    os.replace(temp, path)


def save(state, plan, tickets):
    state['updated_at'] = now()
    state['history'] = state['history'][-200:]
    atomic(STATE, json.dumps(state, indent=2) + '\n')
    data = json.dumps(payload(state, plan, tickets), ensure_ascii=True, indent=2)
    atomic(ROOT / 'status/build-status-view.json', data + '\n')
    atomic(SNAPSHOT, 'window.LARA_BUILD_STATUS = ' + data + ';\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('sync', help='Refresh dashboard from contracts, preserving build status')
    sub.add_parser('check', help='Validate state and generated dashboard data')
    ticket = sub.add_parser('ticket')
    ticket.add_argument('id')
    ticket.add_argument('status', choices=STATES)
    ticket.add_argument('--owner')
    ticket.add_argument('--note')
    ticket.add_argument('--evidence')
    release = sub.add_parser('release', help='Record release-owner attestation, not execute a deployment')
    release.add_argument('id')
    release.add_argument('--evidence', required=True, help='Release tag plus gate report path, including conditional dependency decisions')
    reopen = sub.add_parser('reopen', help='Withdraw a release attestation before correcting its tickets')
    reopen.add_argument('id')
    reopen.add_argument('--note', required=True)
    args = parser.parse_args()
    state, plan, tickets = load()
    by_id = {t['id']: t for t in tickets}
    by_release = {r['id']: r for r in plan['releases']}
    if args.command == 'check':
        expected = payload(state, plan, tickets)
        if read(ROOT / 'status/build-status-view.json') != expected:
            raise ValueError('Dashboard JSON is stale; run sync')
        js = SNAPSHOT.read_text(encoding='utf-8')
        if json.loads(js.removeprefix('window.LARA_BUILD_STATUS = ').removesuffix(';\n')) != expected:
            raise ValueError('Offline snapshot is stale; run sync')
        print(f"PASS: {len(tickets)} tickets, {len(by_release)} release increments; tracker data consistent")
        return
    if args.command == 'ticket':
        if args.id not in by_id:
            raise ValueError('Unknown ticket ID')
        if state['releases'][by_id[args.id]['phase']]['released_at']:
            raise ValueError('Reopen the release before changing its ticket')
        value = state['tickets'][args.id]
        for field in ('owner', 'note', 'evidence'):
            if getattr(args, field) is not None:
                value[field] = getattr(args, field).strip()
        if args.status == 'done' and not value['evidence']:
            raise ValueError('Done requires --evidence with verification results')
        if args.status == 'blocked' and not value['note']:
            raise ValueError('Blocked requires --note explaining the blocker')
        value.update(status=args.status, updated_at=now())
        state['history'].append({'at': now(), 'id': args.id, 'action': args.status, 'note': value['note']})
    elif args.command in ('release', 'reopen'):
        if args.id not in by_release:
            raise ValueError('Unknown release ID')
        if args.command == 'release':
            if not args.evidence.strip():
                raise ValueError('Release evidence cannot be empty')
            if any(state['tickets'][t['id']]['status'] != 'done' for t in tickets if t['phase'] == args.id):
                raise ValueError('All release tickets must be done first')
            if any(not state['releases'][d]['released_at'] for d in by_release[args.id]['depends_on']):
                raise ValueError('Required release dependencies have not shipped')
            state['releases'][args.id] = {'released_at': now(), 'evidence': args.evidence.strip()}
            note = args.evidence.strip()
        else:
            if not args.note.strip():
                raise ValueError('Reopen requires a reason')
            if any(args.id in r['depends_on'] and state['releases'][r['id']]['released_at'] for r in plan['releases']):
                raise ValueError('Reopen dependent releases first')
            state['releases'][args.id] = {'released_at': None, 'evidence': ''}
            note = args.note.strip()
        state['history'].append({'at': now(), 'id': args.id, 'action': args.command, 'note': note})
    save(state, plan, tickets)
    print('Updated build tracker. No application deployment was performed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError) as error:
        raise SystemExit(str(error))
