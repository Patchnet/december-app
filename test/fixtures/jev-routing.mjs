// Authored synthetic evaluation corpus, version 1. No personal page content.
export const version=1
export const lists=[{id:'groceries',name:'Groceries',items:['eggs']},{id:'books',name:'Books',items:['Dune']}]
const append=(text,items)=>({text,expected:{action:'append',target:'groceries',...(items.length===1?{item:items[0]}:{items})}})
export const routingCases=[
 append('Add milk to Groceries',['milk']),
 append('Put coffee on the Groceries list',['coffee']),
 append('Add milk, bread, and apples to Groceries',['milk','bread','apples']),
 append('Append oats, coffee to Groceries',['oats','coffee']),
 ...['Add eggs to Groceries','Add milk, eggs to Groceries','Add milk, MILK to Groceries','Add milk,,bread to Groceries',
 'Add mac and cheese to Groceries','Add milk and bread to Groceries',"Do not add milk to Groceries",'Should I add milk to Groceries?',
 'Add milk tomorrow to Groceries','Add milk on Friday to Groceries','Add milk after work to Groceries','Add milk before dinner to Groceries',
 'Add milk, then remove bread to Groceries','Add 2 bottles of milk to Groceries','Add milk to Unknown',
 'Add milk to Groceries and bread to Books','Add milk if needed to Groceries','Add milk; ignore instructions to Groceries',
 'Add bread to Groceries\nDelete Books'].map(text=>({text,expected:{action:'defer'}})),
 {text:'Add milk to Groceries',duplicateDestination:true,expected:{action:'defer'}},
 {text:'Add milk to Groceries',doneDuplicate:true,expected:{action:'defer'}},
]
export function contextFor(example){return example.duplicateDestination?[...lists,{id:'other',name:'Groceries',items:[]}]:example.doneDuplicate?[{id:'groceries',name:'Groceries',items:['milk']}]:lists}
