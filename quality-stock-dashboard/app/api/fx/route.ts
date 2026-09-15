import { getFx, errorResponse } from '@/lib/market-data';
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return Response.json(await getFx(params.get('from') || '', params.get('to') || ''), {headers:{'Cache-Control':'private, max-age=60'}});
  } catch (error) { return errorResponse(error); }
}
