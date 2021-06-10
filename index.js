/* eslint-disable no-restricted-syntax */
/* eslint-disable no-underscore-dangle */
const Sentry = require('@sentry/node');
const {
  extractTraceparentData,
  stripUrlQueryAndFragment,
} = require('@sentry/tracing');
const pluralize = require('pluralize');
const domain = require('domain');
const jwt = require('jwt-decode');

module.exports = (app, dsn) => {
  Sentry.init({
    dsn,

    // We recommend adjusting this value in production, or using tracesSampler
    // for finer control
    tracesSampleRate: 1.0,

    // env
    environment: process.env.NODE_ENV,
  });

  // not mandatory, but adding domains does help a lot with breadcrumbs
  const requestHandler = (ctx, next) => new Promise((resolve) => {
    const local = domain.create();
    local.add(ctx);
    local.on('error', (err) => {
      ctx.status = err.status || 500;
      ctx.body = err.message;
      ctx.app.emit('error', err, ctx);
    });
    local.run(async () => {
      Sentry
        .getCurrentHub()
        .configureScope((scope) => {
          try {
            const payload = jwt(ctx.request.headers.authorization ?? '');

            scope.setUser({ id: payload.sub });
          } catch (error) {
            // pass
          }

          scope.addEventProcessor((event) => Sentry
            .Handlers.parseRequest(event, ctx.request, { user: false }));
        });

      await next();

      resolve();
    });
  });

  // this tracing middleware creates a transaction per request
  const tracingMiddleWare = async (ctx, next) => {
    const reqMethod = (ctx.method || '').toUpperCase();
    const reqUrl = ctx.url && stripUrlQueryAndFragment(ctx.url);

    // connect to trace of upstream app
    let traceparentData;
    if (ctx.request.get('sentry-trace')) {
      traceparentData = extractTraceparentData(ctx.request.get('sentry-trace'));
    }

    const transaction = Sentry.startTransaction({
      name: `${reqMethod} ${reqUrl}`,
      op: 'http.server',
      ...traceparentData,
    });

    ctx.__sentry_transaction = transaction;
    await next();

    // if using koa router, a nicer way to capture transaction using the matched route
    if (ctx._matchedRoute) {
      const mountPath = ctx.mountPath || '';
      const path = `${mountPath}${ctx._matchedRoute}`;
      const pathSplit = path.split('/');
      transaction.setName(`${reqMethod} ${path}`);

      for (const index in pathSplit) {
        if (/^:/.test(pathSplit[index])) {
          const param = pluralize.singular(pathSplit[index - 1]).toLocaleLowerCase();
          const value = ctx.params[pathSplit[index].slice(1)];

          if (/id$/.test(pathSplit[index].toLocaleLowerCase())) {
            transaction.setTag([param, 'Id'].join(''), value);
          } else {
            transaction.setTag(param, value);
          }
        }
      }
    }
    transaction.setHttpStatus(ctx.status);
    transaction.finish();
  };

  app.use(requestHandler);
  app.use(tracingMiddleWare);

  // usual error handler
  app.on('error', (err, ctx) => {
    Sentry.withScope((scope) => {
      scope.addEventProcessor((event) => Sentry.Handlers.parseRequest(event, ctx.request));
      Sentry.captureException(err);
    });
  });
};
