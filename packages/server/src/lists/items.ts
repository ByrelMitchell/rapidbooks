import { ITEM_TYPES, itemType, type GroupMember, type Item, type ItemInput, type ItemPricesInput } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

interface ItemRow {
  id: number;
  name: string;
  parent_id: number | null;
  type: Item['type'];
  description: string;
  rate: number;
  rate_is_percent: number;
  account_id: number | null;
  inactive: number;
  purchase_description: string;
  cost: number;
  purchase_account_id: number | null;
}

/** Item types that can have a purchase side (cost and purchase account). */
const PURCHASABLE = new Set(['SERVICE', 'PART', 'OTHER_CHARGE']);

/** All items in item-list order (by type, then name, subitems under their parent). */
export function listItems(db: DB): Item[] {
  const rows = db.prepare('SELECT * FROM items').all() as ItemRow[];
  const members = new Map<number, GroupMember[]>();
  for (const m of db
    .prepare('SELECT group_id, item_id, qty, seq FROM item_group_members ORDER BY group_id, seq')
    .all() as (GroupMember & { group_id: number })[]) {
    const list = members.get(m.group_id) ?? [];
    list.push({ item_id: m.item_id, qty: m.qty, seq: m.seq });
    members.set(m.group_id, list);
  }

  const typeOrder = new Map<string, number>(ITEM_TYPES.map((t, i) => [t.code, i]));
  const children = new Map<number | null, ItemRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r);
    children.set(r.parent_id, list);
  }
  const byName = (a: ItemRow, b: ItemRow) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

  const out: Item[] = [];
  const walk = (r: ItemRow, depth: number, prefix: string) => {
    const full_name = prefix ? `${prefix}:${r.name}` : r.name;
    out.push({
      ...r,
      rate_is_percent: !!r.rate_is_percent,
      inactive: !!r.inactive,
      full_name,
      depth,
      type_label: itemType(r.type).label,
      members: members.get(r.id) ?? [],
    });
    for (const c of (children.get(r.id) ?? []).sort(byName)) walk(c, depth + 1, full_name);
  };
  const roots = (children.get(null) ?? []).sort(
    (a, b) => typeOrder.get(a.type)! - typeOrder.get(b.type)! || byName(a, b),
  );
  for (const r of roots) walk(r, 0, '');
  return out;
}

export function getItem(db: DB, id: number): Item {
  const item = listItems(db).find((i) => i.id === id);
  if (!item) throw new AppError(404, 'That item no longer exists.');
  return item;
}

function getRow(db: DB, id: number): ItemRow {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  if (!row) throw new AppError(404, 'That item no longer exists.');
  return row;
}

type NormalItem = ItemInput & { purchase_description: string; cost: number; purchase_account_id: number | null };

/**
 * Validate, and return the input with fields that don't apply to its type cleared.
 * Purchase fields left out keep the stored values (`old`), or default when creating.
 */
function normalize(db: DB, input: ItemInput, selfId: number | null, old?: ItemRow): NormalItem {
  const t = itemType(input.type);
  const out: NormalItem = {
    ...input,
    members: input.members.map((m) => ({ ...m })),
    purchase_description: input.purchase_description ?? old?.purchase_description ?? '',
    cost: input.cost ?? old?.cost ?? 0,
    purchase_account_id: input.purchase_account_id !== undefined ? input.purchase_account_id : (old?.purchase_account_id ?? null),
  };

  if (!PURCHASABLE.has(input.type)) {
    out.purchase_description = '';
    out.cost = 0;
    out.purchase_account_id = null;
  } else if (out.purchase_account_id !== null) {
    const acct = db.prepare('SELECT type FROM accounts WHERE id = ?').get(out.purchase_account_id) as { type: string } | undefined;
    if (!acct) throw new AppError(400, 'The purchase account for this item no longer exists.');
    if (acct.type === 'AR' || acct.type === 'AP') {
      throw new AppError(400, 'An item cannot be bought into an Accounts Receivable or Accounts Payable account.');
    }
  }

  if (input.parent_id !== null) {
    const parent = db.prepare('SELECT type FROM items WHERE id = ?').get(input.parent_id) as { type: string } | undefined;
    if (!parent) throw new AppError(400, 'The parent item no longer exists.');
    if (parent.type !== input.type) throw new AppError(400, 'A subitem must be the same type as its parent item.');
    let p: number | null = input.parent_id;
    while (p !== null) {
      if (p === selfId) throw new AppError(400, 'An item cannot be a subitem of itself.');
      p = getRow(db, p).parent_id;
    }
  }

  if (t.needsAccount) {
    if (input.account_id === null) throw new AppError(400, 'Choose the account this item posts to.');
    const acct = db.prepare('SELECT type FROM accounts WHERE id = ?').get(input.account_id) as
      | { type: string }
      | undefined;
    if (!acct) throw new AppError(400, 'The account for this item no longer exists.');
    if (acct.type === 'AR' || acct.type === 'AP') {
      throw new AppError(400, 'An item cannot post to an Accounts Receivable or Accounts Payable account.');
    }
  } else {
    out.account_id = null;
  }

  if (!t.hasRate) {
    out.rate = 0;
    out.rate_is_percent = false;
  } else {
    if (input.rate_is_percent && !t.allowsPercent) {
      throw new AppError(400, `A ${t.label.toLowerCase()} item's rate must be an amount, not a percentage.`);
    }
    if (input.type === 'DISCOUNT' && input.rate < 0) {
      throw new AppError(400, 'Enter the discount as a positive amount or percentage; it is subtracted automatically.');
    }
    if (input.rate_is_percent && !Number.isInteger(input.rate)) {
      throw new AppError(400, 'A percentage can have at most two decimal places.');
    }
    if (input.rate_is_percent && Math.abs(input.rate) > 10000) {
      throw new AppError(400, 'The percentage cannot be more than 100%.');
    }
  }

  if (input.type === 'GROUP') {
    for (const m of input.members) {
      const member = db.prepare('SELECT type FROM items WHERE id = ?').get(m.item_id) as { type: string } | undefined;
      if (!member) throw new AppError(400, 'One of the items in this group no longer exists.');
      if (member.type === 'GROUP') throw new AppError(400, 'A group cannot contain another group.');
    }
  } else if (input.members.length > 0) {
    throw new AppError(400, 'Only a group item can contain other items.');
  }
  return out;
}

function nameTaken(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    throw new AppError(400, 'That item name is already in use.');
  }
  throw e;
}

function writeMembers(db: DB, groupId: number, input: ItemInput) {
  db.prepare('DELETE FROM item_group_members WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT INTO item_group_members (group_id, item_id, qty, seq) VALUES (?, ?, ?, ?)');
  input.members.forEach((m, seq) => ins.run(groupId, m.item_id, m.qty, seq));
}

const values = (i: NormalItem) => [
  i.name, i.parent_id, i.type, i.description, i.rate, i.rate_is_percent ? 1 : 0, i.account_id, i.inactive ? 1 : 0,
  i.purchase_description, i.cost, i.purchase_account_id,
];

export function createItem(db: DB, input: ItemInput): number {
  const item = normalize(db, input, null);
  return db.transaction(() => {
    let id: number;
    try {
      const r = db
        .prepare(
          `INSERT INTO items (name, parent_id, type, description, rate, rate_is_percent, account_id, inactive,
                              purchase_description, cost, purchase_account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values(item));
      id = Number(r.lastInsertRowid);
    } catch (e) {
      nameTaken(e);
    }
    writeMembers(db, id, item);
    return id;
  })();
}

export function updateItem(db: DB, id: number, input: ItemInput) {
  const old = getRow(db, id);
  const item = normalize(db, input, id, old);
  if (old.type !== item.type) {
    const kids = db.prepare('SELECT COUNT(*) AS n FROM items WHERE parent_id = ?').get(id) as { n: number };
    if (kids.n > 0) throw new AppError(400, 'This item has subitems, so its type cannot be changed.');
    if (item.type === 'GROUP' && isGroupMember(db, id)) {
      throw new AppError(400, 'This item is part of a group, so it cannot become a group itself.');
    }
  }
  if (item.members.some((m) => m.item_id === id)) throw new AppError(400, 'A group cannot contain itself.');
  db.transaction(() => {
    try {
      db.prepare(
        `UPDATE items SET name = ?, parent_id = ?, type = ?, description = ?, rate = ?, rate_is_percent = ?,
                          account_id = ?, inactive = ?, purchase_description = ?, cost = ?,
                          purchase_account_id = ? WHERE id = ?`,
      ).run(...values(item), id);
    } catch (e) {
      nameTaken(e);
    }
    writeMembers(db, id, item);
  })();
}

function isGroupMember(db: DB, id: number) {
  return !!db.prepare('SELECT 1 FROM item_group_members WHERE item_id = ?').get(id);
}

export function deleteItem(db: DB, id: number) {
  const row = getRow(db, id);
  if (db.prepare('SELECT 1 FROM lines WHERE item_id = ? LIMIT 1').get(id)) {
    throw new AppError(400, `${row.name} has been used on transactions and cannot be deleted. You can make it inactive instead.`);
  }
  const kids = db.prepare('SELECT COUNT(*) AS n FROM items WHERE parent_id = ?').get(id) as { n: number };
  if (kids.n > 0) throw new AppError(400, `${row.name} has subitems and cannot be deleted.`);
  if (isGroupMember(db, id)) {
    throw new AppError(400, `${row.name} is part of a group item and cannot be deleted. Remove it from the group first.`);
  }
  db.prepare('DELETE FROM items WHERE id = ?').run(id); // its group members go with it
}

/**
 * Change Item Prices: set the sales price of several items at once, all or none. Only items
 * with a money price (not subtotals, groups or percentage discounts and charges).
 */
export function changeItemPrices(db: DB, input: ItemPricesInput): number {
  const update = db.prepare('UPDATE items SET rate = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of input.prices) {
      const old = getRow(db, p.id);
      if (!itemType(old.type).hasRate || old.rate_is_percent) {
        throw new AppError(400, `The price of "${old.name}" cannot be changed here.`);
      }
      update.run(p.rate, p.id);
    }
  })();
  return input.prices.length;
}
