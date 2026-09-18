create table lara.environment (
 id boolean primary key default true check(id),
 purpose text not null check(purpose='demo')
);
insert into lara.environment(id,purpose) values(true,'demo');
grant select on lara.environment to lara_api,lara_worker;
