import luaparse from 'luaparse';

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export function text(value, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, 'invalid_input');
  }
  return value.trim();
}

export function validateSnapshot(input) {
  if (!input || input.schemaVersion !== 1 || typeof input.content !== 'string'
    || Buffer.byteLength(input.content) > 2 * 1024 * 1024
    || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new ApiError(400, 'invalid_snapshot');
  let ast;
  const source = [...Buffer.from(input.content, 'utf8')].map(byte => String.fromCharCode(byte < 128 ? byte : byte | 0xf700)).join('');
  try { ast = luaparse.parse(source, { luaVersion: '5.1', encodingMode: 'x-user-defined', comments: false }); }
  catch { throw new ApiError(400, 'invalid_saved_variables'); }
  let nodes = 0;
  function literal(node, depth = 0) {
    if (++nodes > 150000 || depth > 64) throw new ApiError(400, 'snapshot_too_complex');
    if (node.type === 'StringLiteral') {
      return Buffer.from([...node.value].map(char => char.charCodeAt(0) & 255)).toString('utf8');
    }
    if (['NumericLiteral', 'BooleanLiteral', 'NilLiteral'].includes(node.type)) {
      if (node.type === 'NumericLiteral' && !Number.isFinite(node.value)) throw new ApiError(400, 'invalid_saved_variables');
      return node.value;
    }
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -literal(node.argument, depth + 1);
    if (node.type !== 'TableConstructorExpression') throw new ApiError(400, 'executable_lua_rejected');
    const result = Object.create(null);
    let index = 0;
    for (const field of node.fields) {
      const key = field.type === 'TableKeyString' ? field.key.name
        : field.type === 'TableKey' ? literal(field.key, depth + 1) : ++index;
      if (!['string', 'number'].includes(typeof key) || Object.hasOwn(result, key)) throw new ApiError(400, 'invalid_saved_variables');
      result[key] = literal(field.value, depth + 1);
    }
    return result;
  }
  const globals = Object.create(null);
  for (const statement of ast.body) {
    const name = statement.variables?.[0]?.name;
    if (statement.type !== 'AssignmentStatement' || statement.variables.length !== 1 || statement.init.length !== 1
      || statement.variables[0].type !== 'Identifier'
      || !['DXPCData', 'DXPCTrackingData', 'DXPCComms', 'DXPCSettings'].includes(name)
      || Object.hasOwn(globals, name)) throw new ApiError(400, 'invalid_saved_variables');
    globals[name] = literal(statement.init[0]);
  }
  const data = globals.DXPCData;
  const identity = data?.syncIdentity;
  if (!identity || typeof identity !== 'object') throw new ApiError(400, 'missing_character_identity');
  const character = { guid: text(identity.guid, 80), name: text(identity.name, 64), realm: text(identity.realm, 128) };
  if (!/^Player-[A-Za-z0-9-]+$/.test(character.guid)) throw new ApiError(400, 'invalid_character_guid');
  if (input.character?.guid !== character.guid || input.character?.name !== character.name || input.character?.realm !== character.realm) {
    throw new ApiError(400, 'character_mismatch');
  }
  const step = data.currentStep ?? 1;
  if (!Number.isSafeInteger(step) || step < 1 || step > 1000000) throw new ApiError(400, 'invalid_step');
  return { ...character, content: input.content, baseRevision: input.baseRevision, step,
    guide: typeof data.currentGuideName === 'string' ? data.currentGuideName.slice(0, 256) : '',
    observedBattleTag: typeof identity.battleTag === 'string' ? identity.battleTag.slice(0, 128) : null };
}
