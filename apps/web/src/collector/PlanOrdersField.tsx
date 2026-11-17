import { useId } from 'react';
import {
  REGION_LABELS,
  regionSchema,
  type CollectorOrder,
  type OrderGroup,
  type Region,
} from '@bottlerun/shared';
import { describedBy } from '../components/describedBy.ts';
import { bottlesText } from './countText.ts';
import { orderTags } from './orderTags.ts';

/** In place of the order list, for a region with no waiting orders. */
export const NO_REGION_ORDERS_TEXT = 'אין הזמנות שממתינות באזור הזה';

/**
 * Under "אזור" while some waiting order has no region: the screen plans by region, so such an
 * order is not offered here until Yoel gives it one in "עריכה" (spec §3.5, "בלי אזור").
 */
export const UNASSIGNED_ORDERS_HINT =
  'הזמנות בלי אזור לא מופיעות כאן. קודם בוחרים להן אזור בעריכה.';

/**
 * The waiting orders of `region`, oldest first as the api listed them; none before a region is
 * chosen. Orders "בלי אזור" are never among them: the api would accept their ids, but a round is
 * planned per region, and Yoel first gives such an order its region in "עריכה".
 */
export function ordersOfRegion(
  groups: readonly OrderGroup[],
  region: Region | undefined,
): CollectorOrder[] {
  if (region === undefined) return [];
  return groups.find((group) => group.key === region)?.orders ?? [];
}

/** "מסומנות: 3 מתוך 4": how many of the region's orders go into the round. */
function checkedSummary(checkedCount: number, total: number): string {
  return `מסומנות: ${checkedCount} מתוך ${total}`;
}

/** Props of {@link PlanOrdersField}. */
interface PlanOrdersFieldProps {
  /** The waiting orders by region group. */
  groups: readonly OrderGroup[];
  /** undefined until Yoel picks one. */
  region: Region | undefined;
  checkedIds: ReadonlySet<string>;
  regionError: string | undefined;
  ordersError: string | undefined;
  onChooseRegion: (region: Region) => void;
  onToggleOrder: (orderId: string, checked: boolean) => void;
}

/**
 * The "איפה" card's content: the region with its waiting-order counts, then, once one is chosen,
 * its orders as checkboxes (spec §3.5). The state stays with the form.
 */
export function PlanOrdersField({
  groups,
  region,
  checkedIds,
  regionError,
  ordersError,
  onChooseRegion,
  onToggleOrder,
}: PlanOrdersFieldProps) {
  const regionGroupName = useId();
  const regionHintId = useId();
  const regionErrorId = useId();
  const ordersSummaryId = useId();
  const ordersErrorId = useId();

  const regionOrders = ordersOfRegion(groups, region);
  const checkedCount = regionOrders.filter((order) => checkedIds.has(order.id)).length;
  const unassignedCount = groups.find((group) => group.key === 'none')?.orders.length ?? 0;

  return (
    <>
      <fieldset
        className="field"
        aria-describedby={describedBy(
          unassignedCount > 0 ? regionHintId : undefined,
          regionError ? regionErrorId : undefined,
        )}
      >
        <legend className="field-label">אזור</legend>
        {unassignedCount > 0 && (
          <p id={regionHintId} className="field-hint">
            {UNASSIGNED_ORDERS_HINT}
          </p>
        )}
        {/* Choice cards with words only, as the region on the edit screen. */}
        <div className="choice-cards">
          {regionSchema.options.map((option) => (
            <label key={option} className="choice-card">
              <input
                type="radio"
                name={regionGroupName}
                value={option}
                checked={region === option}
                onChange={() => onChooseRegion(option)}
                aria-invalid={regionError ? true : undefined}
              />
              {/* The number of orders waiting there, so an empty half is seen before it is
                  chosen. */}
              <span>{`${REGION_LABELS[option]} (${ordersOfRegion(groups, option).length})`}</span>
            </label>
          ))}
        </div>
        {regionError && (
          <p id={regionErrorId} className="field-error">
            {regionError}
          </p>
        )}
      </fieldset>

      {region !== undefined && (
        <fieldset
          className="field"
          aria-describedby={describedBy(
            regionOrders.length > 0 ? ordersSummaryId : undefined,
            ordersError ? ordersErrorId : undefined,
          )}
        >
          <legend className="field-label">הזמנות לסבב</legend>
          {regionOrders.length === 0 ? (
            <p className="field-hint">{NO_REGION_ORDERS_TEXT}</p>
          ) : (
            <>
              <p id={ordersSummaryId} className="field-hint">
                {checkedSummary(checkedCount, regionOrders.length)}
              </p>
              <div className="grouped-list plan-order-list">
                {regionOrders.map((order) => (
                  <PlanOrderRow
                    key={order.id}
                    order={order}
                    checked={checkedIds.has(order.id)}
                    invalid={Boolean(ordersError)}
                    onToggle={onToggleOrder}
                  />
                ))}
              </div>
            </>
          )}
          {ordersError && (
            <p id={ordersErrorId} className="field-error">
              {ordersError}
            </p>
          )}
        </fieldset>
      )}
    </>
  );
}

/** Props of {@link PlanOrderRow}. */
interface PlanOrderRowProps {
  order: CollectorOrder;
  checked: boolean;
  /** True while the list has an error ("נא לסמן לפחות הזמנה אחת", too many). */
  invalid: boolean;
  onToggle: (orderId: string, checked: boolean) => void;
}

/**
 * One waiting order of the region as a checkbox row: who, where, how many bottles, and its tags
 * (orderTags.ts: why it came back from a round, "בלי מיקום"). A row of the grouped list, with a big
 * checkbox; the whole row (64px+) is the tap target.
 * The checkbox is named by the customer's name alone and described by the rest, so a screen
 * reader says the name first and the details after.
 */
function PlanOrderRow({ order, checked, invalid, onToggle }: PlanOrderRowProps) {
  const nameId = useId();
  const detailsId = useId();
  const tags = orderTags(order);

  return (
    <label className="grouped-row plan-order">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(order.id, event.target.checked)}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        aria-invalid={invalid ? true : undefined}
      />
      <span className="plan-order-details">
        <span id={nameId} className="plan-order-name">
          {order.contact.name}
        </span>
        <span id={detailsId} className="plan-order-more">
          <span>
            {order.address.streetName} {order.address.houseNumber}
          </span>
          <span>{bottlesText(order.bottlesEstimated)}</span>
          {tags.length > 0 && (
            <span className="tag-list">
              {tags.map((tag) => (
                <span key={tag} className="badge">
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
