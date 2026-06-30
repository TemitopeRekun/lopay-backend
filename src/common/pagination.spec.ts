import {
  parsePagination,
  paginate,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './pagination';

describe('parsePagination', () => {
  it('defaults to page 1 and the default size when nothing is provided', () => {
    expect(parsePagination()).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      skip: 0,
    });
  });

  it('parses valid string query params', () => {
    expect(parsePagination('3', '20')).toEqual({
      page: 3,
      limit: 20,
      skip: 40,
    });
  });

  it('CLAMPS limit to MAX_PAGE_SIZE (cannot request the whole table)', () => {
    expect(parsePagination('1', '100000').limit).toBe(MAX_PAGE_SIZE);
    expect(parsePagination('1', String(MAX_PAGE_SIZE + 1)).limit).toBe(
      MAX_PAGE_SIZE,
    );
  });

  it('respects an explicit max under the global cap', () => {
    expect(parsePagination('1', '500', { maxLimit: 100 }).limit).toBe(100);
  });

  it('falls back to defaults for non-positive / non-integer / garbage input', () => {
    for (const bad of ['0', '-5', 'abc', '1.5', '', null, undefined]) {
      expect(parsePagination(bad as string, bad as string)).toEqual({
        page: 1,
        limit: DEFAULT_PAGE_SIZE,
        skip: 0,
      });
    }
  });

  it('computes skip from the clamped page/limit', () => {
    expect(parsePagination('4', '25').skip).toBe(75);
  });
});

describe('paginate', () => {
  it('wraps rows + total into the standard envelope', () => {
    expect(paginate([1, 2], 42, 2, 10)).toEqual({
      items: [1, 2],
      total: 42,
      page: 2,
      limit: 10,
      totalPages: 5,
    });
  });

  it('rounds totalPages up for a partial last page', () => {
    expect(paginate([], 41, 1, 10).totalPages).toBe(5);
  });
});
