const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {metricsFor, periodReturn} = require(path.join(process.env.QUALITY_TEST_BUILD,'finance.js'));
const {parseFundamentals, parseChart, chartParams, validateSymbol} = require(path.join(process.env.QUALITY_TEST_BUILD,'market-data.js'));
const year = {date:'2025-06-30', currency:'GBP', revenue:500, grossProfit:300, operatingIncome:100, ebit:90, interestExpense:5, netIncome:60, operatingCashFlow:100, capex:20, freeCashFlow:80, totalAssets:600, currentLiabilities:100, basicAverageShares:10, ordinaryShares:10};
const prior = {...year, date:'2024-06-30', totalAssets:500, freeCashFlow:64};

test('ROCE uses average capital, and cash conversion uses free cash flow', () => {
 const m=metricsFor(year,prior,{price:2000,currency:'GBp'});
 assert.equal(m.roce.value,20);
 assert.equal(m.cashConversion.value,80/60*100);
 assert.equal(m.interestCover.value,18);
 assert.equal(m.fcfGrowth.value,25);
 assert.equal(metricsFor({...year,currency:'USD'},prior,{price:2000,currency:'GBp'},{from:'USD',to:'GBP',rate:.8}).fcfYield.value,32);
 assert.equal(m.fcfYield.value,40); // £8 per share / £20, not 2,000 pence.
});
test('missing data, loss-making denominators and mismatched currencies never turn into valid ratios',()=>{
 assert.equal(metricsFor({...year,netIncome:0},prior).cashConversion.value,null);
 assert.equal(metricsFor({...year,netIncome:-20},prior).cashConversion.value,null);
 assert.equal(metricsFor({...year,interestExpense:null},prior).interestCover.value,null);
 assert.match(metricsFor({...year,interestExpense:0},prior).interestCover.reason,/N\/M/);
 assert.equal(metricsFor(year,{...prior,freeCashFlow:0}).fcfGrowth.value,null);
 assert.equal(metricsFor(year,undefined).roce.value,null);
 assert.equal(metricsFor(year,{...prior,date:'2022-06-30'}).roce.value,null);
 assert.equal(metricsFor(year,prior,{price:20,currency:'USD'}).fcfYield.value,null);
 assert.equal(metricsFor({...year,basicAverageShares:null},prior,{price:20,currency:'GBP'}).fcfYield.value,null);
});
test('financial parsing normalises capex signs, aligns periods, and refuses mixed reporting currencies',()=>{
 const field=(name,value,currency='USD')=>({meta:{type:['annual'+name]},['annual'+name]:[{asOfDate:'2025-06-30',periodType:'12M',currencyCode:currency,reportedValue:{raw:value}}]});
 const result=[field('TotalRevenue',500),field('OperatingCashFlow',100),field('CapitalExpenditure',-20),field('NetIncome',60)];
 assert.equal(parseFundamentals({timeseries:{result}},'MSFT').years[0].freeCashFlow,80);
 assert.equal(parseFundamentals({timeseries:{result:result.slice(0,2)}},'MSFT').years[0].freeCashFlow,null);
 assert.throws(()=>parseFundamentals({timeseries:{result:[...result,field('GrossProfit',250,'EUR')]}},'MSFT'),/unavailable/);
});
test('history skips null prices and does not mistake period-start close for yesterday’s close',()=>{
 const parsed=parseChart({chart:{result:[{meta:{symbol:'MSFT',currency:'USD',regularMarketPrice:110,chartPreviousClose:20,regularMarketChangePercent:10},timestamp:[1704205800,1704292200,1704378600],indicators:{quote:[{close:[100,null,110],volume:[0,null,200]}],adjclose:[{adjclose:[90,null,100]}]}}]}},'MSFT','1y','1d');
 assert.equal(parsed.points.length,2); assert.equal(parsed.points[0].volume,0);
 assert.ok(Math.abs(parsed.previousClose-100)<1e-9);
 assert.ok(Math.abs(periodReturn(parsed.points)-10)<1e-9);
 assert.ok(Math.abs(periodReturn(parsed.points,true)-(100/90-1)*100)<1e-9);
});
test('API rejects malformed symbols, calendar dates and unsupported ranges',()=>{
 assert.equal(validateSymbol(' ulvr.l '),'ULVR.L'); assert.equal(validateSymbol('brk-b'),'BRK-B');
 assert.throws(()=>validateSymbol('https://example.com'),/valid Yahoo ticker/);
 assert.throws(()=>chartParams(new URLSearchParams({symbol:'MSFT',range:'100y'})),/supported/);
 assert.throws(()=>chartParams(new URLSearchParams({symbol:'MSFT',range:'custom',start:'2025-02-30',end:'2025-05-01'})),/start date/);
 assert.throws(()=>chartParams(new URLSearchParams({symbol:'MSFT',range:'custom',start:'2025-01-01',end:'2999-01-01'})),/start date/);
});
