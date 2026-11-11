import { ITEM_TYPES, itemType, type Account, type Item, type ItemInput, type ItemTypeCode } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef } from 'react';
import { api, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { RateField, type Rate } from '../controls/RateField';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { accountQuickFill, itemQuickFill } from './quickAdd';
import { RecordDialogFrame, useRecordDialog } from './RecordDialog';
import './dialogs2013.css';

interface Member {
  key: number;
  item_id: number | null;
  qty: string;
}
interface Form {
  type: ItemTypeCode;
  name: string;
  isSub: boolean;
  parent_id: number | null;
  description: string;
  rate: Rate;
  account_id: number | null;
  inactive: boolean;
  members: Member[];
  /** "This item is purchased from vendors": the purchase side below is in use. */
  purchased: boolean;
  purchase_description: string;
  /** Cents, up to 3 decimals (five decimals of dollars); null = blank. */
  cost: number | null;
  purchase_account_id: number | null;
  /** The stored item had purchase information (so clearing it must be sent). */
  hadPurchase: boolean;
}

/** Item types that can be bought on purchase orders, bills and checks. */
const PURCHASABLE: ItemTypeCode[] = ['SERVICE', 'PART', 'OTHER_CHARGE'];

let memberSeq = 0;
const blankMember = (): Member => ({ key: ++memberSeq, item_id: null, qty: '1' });
/** Always one blank row at the end of the group grid. */
function withBlank(ms: Member[]): Member[] {
  const last = ms[ms.length - 1];
  return last && last.item_id === null ? ms : [...ms, blankMember()];
}

const blankForm = (type: ItemTypeCode = 'SERVICE', name = ''): Form => ({
  type,
  name,
  isSub: false,
  parent_id: null,
  description: '',
  rate: { rate: 0, percent: false },
  account_id: null,
  inactive: false,
  members: withBlank([]),
  purchased: false,
  purchase_description: '',
  cost: null,
  purchase_account_id: null,
  hadPurchase: false,
});

const RATE_LABEL: Partial<Record<ItemTypeCode, string>> = {
  SERVICE: 'Rate',
  PART: 'Price',
  OTHER_CHARGE: 'Amount or %',
  DISCOUNT: 'Amount or %',
};

/** QuickBooks 2013's words beside the Type box. */
const TYPE_HELP: Record<ItemTypeCode, string> = {
  SERVICE: 'Use for services you charge for or purchase, like specialized labor, consulting hours, or professional fees.',
  PART: "Use for goods you buy but don't track, like office supplies, or materials for a specific job that you charge back to the customer.",
  OTHER_CHARGE: 'Use for miscellaneous labor, material, or part charges, such as delivery charges, setup fees, and service charges.',
  SUBTOTAL: 'Use to total several items on a form, for example to apply a discount to them.',
  GROUP: 'Use to quickly enter a group of individual items on an invoice.',
  DISCOUNT: 'Use to subtract a percentage or fixed amount from a total or subtotal. Do not use this item type for an early payment discount.',
};

/** The 2013 check box that opens the Purchase / Sales Information halves. */
const PURCHASE_CHECK: Partial<Record<ItemTypeCode, string>> = {
  SERVICE: 'This service is used in assemblies or is performed by a subcontractor or partner',
  PART: 'This item is used in assemblies or is purchased for a specific customer:job',
  OTHER_CHARGE: 'This item is used in assemblies or is a reimbursable charge',
};

function toBody(f: Form): ItemInput | string {
  const t = itemType(f.type);
  const members: ItemInput['members'] = [];
  if (f.type === 'GROUP') {
    for (const m of f.members) {
      if (m.item_id === null) continue;
      const qty = Number(m.qty.replace(/,/g, '').trim() || '1');
      if (!Number.isFinite(qty)) return 'Enter a quantity (a number) for each item in the group.';
      members.push({ item_id: m.item_id, qty });
    }
  }
  // The purchase side goes only when it is in use or was stored, so an item saved here
  // without it keeps whatever the server has (and an older item is not wiped).
  const buys = PURCHASABLE.includes(f.type) && f.purchased;
  const purchase: Partial<ItemInput> =
    buys || f.hadPurchase
      ? {
          purchase_description: buys ? f.purchase_description : '',
          cost: buys ? f.cost ?? 0 : 0,
          purchase_account_id: buys ? f.purchase_account_id : null,
        }
      : {};
  return {
    ...purchase,
    name: f.name,
    type: f.type,
    parent_id: f.isSub ? f.parent_id : null,
    description: f.description,
    rate: t.hasRate ? f.rate.rate : 0,
    rate_is_percent: t.hasRate && f.rate.percent,
    account_id: t.needsAccount ? f.account_id : null,
    inactive: f.inactive,
    members,
  };
}

/** The dialog's form for a stored item. */
function fromItem(i: Item): Form {
  const had = i.purchase_description !== '' || i.cost !== 0 || i.purchase_account_id !== null;
  return {
    type: i.type,
    name: i.name,
    isSub: i.parent_id !== null,
    parent_id: i.parent_id,
    description: i.description,
    rate: { rate: i.rate, percent: i.rate_is_percent },
    account_id: i.account_id,
    inactive: i.inactive,
    members: withBlank(i.members.map((m) => ({ key: ++memberSeq, item_id: m.item_id, qty: String(m.qty) }))),
    purchased: had,
    purchase_description: i.purchase_description,
    cost: i.cost !== 0 ? i.cost : null,
    purchase_account_id: i.purchase_account_id,
    hadPurchase: had,
  };
}

export function ItemDialog({ winId, props }: WinProps) {
  const id = (props.id as number | null | undefined) ?? null;
  const presetParent = (props.parentId as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: items } = useData<Item[]>('/api/items');
  const { data: accounts } = useData<Account[]>('/api/accounts');

  const dlg = useRecordDialog<Form>({
    winId,
    id,
    initial: () => blankForm((props.type as ItemTypeCode | undefined) ?? 'SERVICE', (props.name as string | undefined) ?? ''),
    blank: (prev) => blankForm(prev.type),
    load: async (rid) => fromItem(await api.get<Item>(`/api/items/${rid}`)),
    validate: (f) => {
      if (f.isSub && f.parent_id === null) return 'Choose the parent item, or clear "Subitem of".';
      if (PURCHASABLE.includes(f.type) && f.purchased && (f.cost ?? 0) < 0) return 'The cost cannot be negative.';
      const b = toBody(f);
      return typeof b === 'string' ? b : null;
    },
    save: async (f, rid) => {
      const body = toBody(f) as ItemInput;
      if (rid === null) return (await api.post<{ id: number }>('/api/items', body)).id;
      await api.put(`/api/items/${rid}`, body);
      return rid;
    },
    titles: { new: 'New Item', edit: 'Edit Item' },
    savedMessage: (f) => `Item "${f.name.trim()}" saved.`,
    openNew: () => desk.open('item', { id: null }),
  });
  const { form, setForm, update, recId } = dlg;
  const t = itemType(form.type);

  // Set Up for "Parent:Child": once the items load, the new item is a subitem of that parent, of its type.
  const presetDone = useRef(presetParent === null);
  useEffect(() => {
    if (presetDone.current || !items) return;
    presetDone.current = true;
    const p = items.find((x) => x.id === presetParent);
    if (p) setForm((f) => ({ ...f, type: p.type, isSub: true, parent_id: p.id }));
  }, [items, presetParent, setForm]);

  // Item > Duplicate Item: a new item with everything of that one but its name.
  const copyOf = (props.copyOf as number | undefined) ?? null;
  const copyDone = useRef(copyOf === null);
  useEffect(() => {
    if (copyDone.current || !items) return;
    copyDone.current = true;
    const src = items.find((x) => x.id === copyOf);
    if (src) setForm({ ...fromItem(src), name: '', inactive: false, hadPurchase: false });
  }, [items, copyOf, setForm]);

  // Possible parents: same type, not this item or anything under it.
  const parentOptions = useMemo(() => {
    const list = items ?? [];
    const under = new Set<number>(recId !== null ? [recId] : []);
    for (const i of list) if (i.parent_id !== null && under.has(i.parent_id)) under.add(i.id);
    return list
      .filter((i) => i.type === form.type && !under.has(i.id) && (!i.inactive || i.id === form.parent_id))
      .map((i) => ({ id: i.id, label: i.full_name }));
  }, [items, form.type, recId, form.parent_id]);

  const memberOptions = useMemo(() => {
    const used = new Set(form.members.map((m) => m.item_id));
    return (items ?? [])
      .filter((i) => i.type !== 'GROUP' && i.id !== recId && (!i.inactive || used.has(i.id)))
      .map((i) => ({ id: i.id, label: i.full_name }));
  }, [items, recId, form.members]);

  const accountOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => a.type !== 'AR' && a.type !== 'AP' && (!a.inactive || a.id === form.account_id))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form.account_id],
  );

  const purchaseAccountOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => a.type !== 'AR' && a.type !== 'AP' && (!a.inactive || a.id === form.purchase_account_id))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form.purchase_account_id],
  );

  const setMember = (i: number, patch: Partial<Member>) =>
    setForm((f) => {
      const members = [...f.members];
      members[i] = { ...members[i], ...patch };
      return { ...f, members: withBlank(members) };
    });

  const fid = (k: string) => `${winId}-${k}`;
  const buys = PURCHASABLE.includes(form.type) && form.purchased;
  const description = (
    <textarea
      id={fid('desc')}
      className="field"
      rows={3}
      value={form.description}
      onChange={(e) => update({ description: e.target.value })}
    />
  );
  const rateLabel = (label: string) => <label htmlFor={fid('rate')}>{label}</label>;
  const rateField = (
    <RateField
      id={fid('rate')}
      className="rate-field"
      value={form.rate}
      onChange={(rate) => update({ rate })}
      title={t.allowsPercent ? 'An amount, or a percentage such as 10%' : 'Up to five decimal places'}
    />
  );
  const accountLabel = (label: string) => <label htmlFor={fid('account')}>{label}</label>;
  const accountCombo = (
    <Combo
      id={fid('account')}
      options={accountOptions}
      value={form.account_id}
      onChange={(a) => update({ account_id: a })}
      {...accountQuickFill(desk, { type: 'INC' })}
    />
  );

  return (
    <RecordDialogFrame
      dlg={dlg}
      winId={winId}
      className="it13"
      inactive={
        <label className="check">
          <input type="checkbox" checked={form.inactive} onChange={(e) => update({ inactive: e.target.checked })} />
          Item is inactive
        </label>
      }
    >
      <fieldset className="it-type">
        <legend>
          <label htmlFor={fid('type')}>Type</label>
        </legend>
        <select
          id={fid('type')}
          className="field"
          value={form.type}
          // The type is fixed once the item exists.
          disabled={recId !== null}
          onChange={(e) => {
            const type = e.target.value as ItemTypeCode;
            const nt = itemType(type);
            update({
              type,
              isSub: false,
              parent_id: null,
              rate: nt.allowsPercent ? form.rate : { rate: form.rate.rate, percent: false },
              members: withBlank([]),
            });
          }}
        >
          {ITEM_TYPES.map((x) => (
            <option key={x.code} value={x.code}>
              {x.label}
            </option>
          ))}
        </select>
        <p className="it-type-help">{TYPE_HELP[form.type]}</p>
      </fieldset>

      <div className="it-row">
        <div className="stack">
          <label htmlFor={fid('name')}>Item Name/Number</label>
          <input
            id={fid('name')}
            className="field"
            value={form.name}
            maxLength={100}
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={form.isSub} onChange={(e) => update({ isSub: e.target.checked })} />
            Subitem of
          </label>
          <Combo
            options={parentOptions}
            value={form.isSub ? form.parent_id : null}
            onChange={(pid) => update({ parent_id: pid })}
            disabled={!form.isSub}
            aria-label="Parent item"
            listName="Item"
          />
        </div>
      </div>

      {PURCHASABLE.includes(form.type) && (
        <label className="check">
          <input type="checkbox" checked={form.purchased} onChange={(e) => update({ purchased: e.target.checked })} />
          {PURCHASE_CHECK[form.type]}
        </label>
      )}

      {buys ? (
        <div className="it-box two">
          <div className="stack">
            <b>Purchase Information</b>
            <label htmlFor={fid('pdesc')}>Description on Purchase Transactions</label>
            <textarea
              id={fid('pdesc')}
              className="field"
              rows={3}
              value={form.purchase_description}
              onChange={(e) => update({ purchase_description: e.target.value })}
            />
            <label htmlFor={fid('cost')}>Cost</label>
            <AmountField
              id={fid('cost')}
              className="rate-field"
              decimals={5}
              value={form.cost}
              onChange={(cost) => update({ cost })}
              title="Up to five decimal places"
            />
            <label htmlFor={fid('pacct')}>Expense Account</label>
            <Combo
              id={fid('pacct')}
              options={purchaseAccountOptions}
              value={form.purchase_account_id}
              onChange={(a) => update({ purchase_account_id: a })}
              {...accountQuickFill(desk, { type: 'EXP' })}
            />
          </div>
          <div className="stack">
            <b>Sales Information</b>
            <label htmlFor={fid('desc')}>Description on Sales Transactions</label>
            {description}
            {rateLabel('Sales Price')}
            {rateField}
            {accountLabel('Income Account')}
            {accountCombo}
          </div>
        </div>
      ) : (
        <div className={t.hasRate ? 'it-box' : 'it-box two'}>
          <div className="stack">
            <label htmlFor={fid('desc')}>Description</label>
            {description}
          </div>
          {t.hasRate && (
            <div className="it-side">
              {rateLabel(RATE_LABEL[form.type] ?? 'Rate')}
              {rateField}
              {t.needsAccount && (
                <>
                  {accountLabel('Account')}
                  {accountCombo}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {form.type === 'GROUP' && (
        <div className="grid-wrap group-grid">
          <table className="line-grid">
            <colgroup>
              <col />
              <col style={{ width: '6rem' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Item</th>
                <th className="al-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {form.members.map((m, i) => (
                <tr key={m.key}>
                  <td>
                    <Combo
                      options={memberOptions}
                      value={m.item_id}
                      onChange={(item_id) => setMember(i, { item_id })}
                      aria-label={`Item, line ${i + 1}`}
                      {...itemQuickFill(desk)}
                    />
                  </td>
                  <td>
                    <input
                      className="field amount-field"
                      value={m.qty}
                      inputMode="decimal"
                      aria-label={`Qty, line ${i + 1}`}
                      onChange={(e) => setMember(i, { qty: e.target.value })}
                      onFocus={(e) => e.target.select()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </RecordDialogFrame>
  );
}
