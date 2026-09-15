import { validateSymbol, getFundamentals, errorResponse } from '@/lib/market-data';
export async function GET(request: Request) {
  try { return Response.json(await getFundamentals(validateSymbol(new URL(request.url).searchParams.get('symbol'))), { headers: {'Cache-Control':'private, max-age=300'} }); }
  catch (error) { return errorResponse(error); }
}
