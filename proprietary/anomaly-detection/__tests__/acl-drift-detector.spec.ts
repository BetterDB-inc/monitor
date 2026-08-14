import {
  AclDriftNode,
  aclDriftSignature,
  aclUserDigest,
  detectAclDrift,
  nodeAclDigest,
  parseAclLine,
} from '../acl-drift-detector';

const DEFAULT_LINE = 'user default on nopass sanitize-payload ~* &* +@all';
const APP_LINE = 'user app on #a3b1 ~cache:* &notifications +@read +@write';
const APP_LINE_WIDER = 'user app on #a3b1 ~cache:* ~secret:* &notifications +@read +@write';

function node(partial: Partial<AclDriftNode> & Pick<AclDriftNode, 'connectionId'>): AclDriftNode {
  const lines = [DEFAULT_LINE, APP_LINE];
  const { digest, userDigests } = nodeAclDigest(lines);
  return { groupKey: 'replid:abc', digest, userDigests, ...partial };
}

function nodeFrom(connectionId: string, lines: string[], groupKey = 'replid:abc'): AclDriftNode {
  const { digest, userDigests } = nodeAclDigest(lines);
  return { connectionId, groupKey, digest, userDigests };
}

describe('parseAclLine', () => {
  it('splits an ACL LIST line into username and rules', () => {
    expect(parseAclLine(DEFAULT_LINE)).toEqual({
      username: 'default',
      rules: ['on', 'nopass', 'sanitize-payload', '~*', '&*', '+@all'],
    });
  });

  it('rejects a line that is not a user line', () => {
    expect(parseAclLine('')).toBeNull();
    expect(parseAclLine('something else entirely')).toBeNull();
    expect(parseAclLine('user')).toBeNull();
  });

  it('tolerates irregular whitespace', () => {
    expect(parseAclLine('  user   app   on  ~*  ')).toEqual({
      username: 'app',
      rules: ['on', '~*'],
    });
  });
});

describe('aclUserDigest', () => {
  it('is independent of rule ordering', () => {
    const a = aclUserDigest('app', ['+@read', '~cache:*', 'on']);
    const b = aclUserDigest('app', ['on', '~cache:*', '+@read']);
    expect(a).toBe(b);
  });

  it('changes when a rule changes', () => {
    const before = aclUserDigest('app', ['on', '~cache:*']);
    const after = aclUserDigest('app', ['on', '~cache:*', '~secret:*']);
    expect(before).not.toBe(after);
  });

  it('is case-sensitive, since key and channel patterns are', () => {
    expect(aclUserDigest('app', ['~Cache:*'])).not.toBe(aclUserDigest('app', ['~cache:*']));
  });

  it('separates the username from the rules so they cannot be confused', () => {
    expect(aclUserDigest('ab', ['c'])).not.toBe(aclUserDigest('a', ['bc']));
  });
});

describe('nodeAclDigest', () => {
  it('is independent of user ordering', () => {
    const forward = nodeAclDigest([DEFAULT_LINE, APP_LINE]).digest;
    const reversed = nodeAclDigest([APP_LINE, DEFAULT_LINE]).digest;
    expect(forward).toBe(reversed);
  });

  it('changes when any user changes', () => {
    const before = nodeAclDigest([DEFAULT_LINE, APP_LINE]).digest;
    const after = nodeAclDigest([DEFAULT_LINE, APP_LINE_WIDER]).digest;
    expect(before).not.toBe(after);
  });

  it('exposes one digest per user', () => {
    const { userDigests } = nodeAclDigest([DEFAULT_LINE, APP_LINE]);
    expect(Object.keys(userDigests).sort()).toEqual(['app', 'default']);
  });

  it('skips unparseable lines rather than poisoning the digest', () => {
    const clean = nodeAclDigest([DEFAULT_LINE]).digest;
    const withNoise = nodeAclDigest([DEFAULT_LINE, '', 'garbage line']).digest;
    expect(withNoise).toBe(clean);
  });

  it('digests an empty ruleset to a stable zero value', () => {
    expect(nodeAclDigest([]).digest).toBe('0000000000000000');
  });
});

describe('detectAclDrift', () => {
  it('stays silent when every node in the group agrees', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-c', [APP_LINE, DEFAULT_LINE]),
    ];
    expect(detectAclDrift(nodes)).toEqual([]);
  });

  it('fires and names the differing user when one node diverges', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER]),
    ];

    const [drift] = detectAclDrift(nodes);
    expect(drift.usernames).toEqual(['app']);
    expect(drift.nodes.map((n) => n.connectionId)).toEqual(['conn-a', 'conn-b']);
    expect(new Set(drift.nodes.map((n) => n.digest)).size).toBe(2);
  });

  it('names a user that exists on one node and not the other', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [DEFAULT_LINE]),
    ];

    const [drift] = detectAclDrift(nodes);
    expect(drift.usernames).toEqual(['app']);
  });

  it('does not compare nodes in different replication groups', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE], 'replid:one'),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER], 'replid:two'),
    ];
    expect(detectAclDrift(nodes)).toEqual([]);
  });

  it('needs at least two nodes — a standalone node cannot drift', () => {
    expect(detectAclDrift([nodeFrom('conn-a', [DEFAULT_LINE])])).toEqual([]);
  });

  it('ignores nodes with no group key', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE], ''),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER], ''),
    ];
    expect(detectAclDrift(nodes)).toEqual([]);
  });

  it('reports every differing user in one finding per group', () => {
    const otherDefault = 'user default on nopass ~cache:* +@all';
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [otherDefault, APP_LINE_WIDER]),
    ];

    const drifts = detectAclDrift(nodes);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].usernames).toEqual(['app', 'default']);
  });

  it('carries no rule material into the finding', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER]),
    ];

    const serialized = JSON.stringify(detectAclDrift(nodes));
    expect(serialized).not.toContain('secret:*');
    expect(serialized).not.toContain('#a3b1');
    expect(serialized).not.toContain('+@all');
  });
});

describe('aclDriftSignature', () => {
  it('is stable across repeated evaluation of the same drift', () => {
    const nodes = [
      nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER]),
    ];
    const first = aclDriftSignature(detectAclDrift(nodes)[0]);
    const second = aclDriftSignature(detectAclDrift([...nodes].reverse())[0]);
    expect(first).toBe(second);
  });

  it('changes when a node adopts a different ruleset', () => {
    const before = aclDriftSignature(
      detectAclDrift([
        nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
        nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER]),
      ])[0],
    );
    const after = aclDriftSignature(
      detectAclDrift([
        nodeFrom('conn-a', [DEFAULT_LINE, APP_LINE]),
        nodeFrom('conn-b', [DEFAULT_LINE]),
      ])[0],
    );
    expect(before).not.toBe(after);
  });

  it('accepts a node built through the default fixture', () => {
    const drift = detectAclDrift([
      node({ connectionId: 'conn-a' }),
      nodeFrom('conn-b', [DEFAULT_LINE, APP_LINE_WIDER]),
    ])[0];
    expect(aclDriftSignature(drift)).toContain('replid:abc');
  });
});

describe('parseAclLine — selectors', () => {
  const WITH_SELECTOR = 'user alice on #a3b1 ~key1 +get (%R~key2 +set +get)';

  it('keeps a selector together instead of splitting it on spaces', () => {
    expect(parseAclLine(WITH_SELECTOR)).toEqual({
      username: 'alice',
      rules: ['on', '#a3b1', '~key1', '+get', '(%R~key2 +set +get)'],
    });
  });

  it('digests a selector identically wherever it appears in the line', () => {
    const reordered = 'user alice on (%R~key2 +set +get) #a3b1 +get ~key1';
    expect(nodeAclDigest([WITH_SELECTOR]).digest).toBe(nodeAclDigest([reordered]).digest);
  });

  it('still distinguishes a genuinely different selector', () => {
    const wider = 'user alice on #a3b1 ~key1 +get (%RW~key2 +set +get)';
    expect(nodeAclDigest([WITH_SELECTOR]).digest).not.toBe(nodeAclDigest([wider]).digest);
  });

  it('does not report drift between peers that render selectors in a different order', () => {
    const reordered = 'user alice on (%R~key2 +set +get) #a3b1 +get ~key1';
    const nodes = [nodeFrom('conn-a', [WITH_SELECTOR]), nodeFrom('conn-b', [reordered])];

    expect(detectAclDrift(nodes)).toEqual([]);
  });

  it('handles multiple selectors on one line', () => {
    const two = 'user bob on ~a +get (%R~x +get) (%W~y +set)';
    expect(parseAclLine(two)?.rules).toEqual(['on', '~a', '+get', '(%R~x +get)', '(%W~y +set)']);
  });
});
