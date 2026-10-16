-- Test-only: call any public function with named arguments from a JSON object,
-- the way PostgREST does, and return its result or the error as JSON.
create or replace function public.test_call(p_fn text, p_args jsonb) returns jsonb language plpgsql as $$
declare
  v_oid oid;
  v_names text[];
  v_types oid[];
  v_parts text[] := '{}';
  v_type text;
  v_result jsonb;
  v_msg text; v_hint text; v_detail text;
begin
  select p.oid, p.proargnames, p.proargtypes::oid[] into v_oid, v_names, v_types
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_fn;
  if v_oid is null then return jsonb_build_object('error', jsonb_build_object('message', 'no such function ' || p_fn, 'hint', '404')); end if;
  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    if not p_args ? v_names[i] then continue; end if;
    v_type := format_type(v_types[i - 1], null);
    v_parts := v_parts || case
      when v_type = 'jsonb' then format('%I => $1->%L', v_names[i], v_names[i])
      when v_type like '%[]' then format('%I => (select array_agg(x::%s) from jsonb_array_elements_text($1->%L) x)', v_names[i], replace(v_type, '[]', ''), v_names[i])
      else format('%I => ($1->>%L)::%s', v_names[i], v_names[i], v_type) end;
  end loop;
  begin
    execute format('select to_jsonb(public.%I(%s))', p_fn, array_to_string(v_parts, ', ')) into v_result using p_args;
    return jsonb_build_object('data', v_result);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    return jsonb_build_object('error', jsonb_build_object('message', v_msg, 'hint', v_hint, 'details', v_detail));
  end;
end $$;
