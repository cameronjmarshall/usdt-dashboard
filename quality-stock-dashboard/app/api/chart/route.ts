import { chartParams, getChart, errorResponse } from '@/lib/market-data';
export async function GET(request: Request) {
  try { return Response.json(await getChart(chartParams(new URL(request.url).searchParams)), { headers: {'Cache-Control':'private, max-age=60'} }); }
  catch (error) { return errorResponse(error); }
}
