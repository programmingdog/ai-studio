/** Sum the same six-decimal prices returned by the billing API. */
export const workflowTotal = (items: { credits: number }[]) => items.reduce((sum,item)=>sum+Math.round(item.credits*1e6),0)/1e6;
