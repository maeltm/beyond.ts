import Future = require('sfuture');
import fluentd = require('fluent-logger');
import _ = require('underscore');
import util = require('util');
import db = require('../../core/db');

interface IMessageLogger {
  log(message: string, args: any[]): Future<void>;
}

/* istanbul ignore next */
class StdoutLogger implements IMessageLogger {
  private level: string;
  constructor(level: string) {
    this.level = level;
  }

  log(message: string, args: any[]): Future<void> {
    const formattedMessage = util.format(message, ...args);
    console.log('%s: %s', this.level, formattedMessage);
    return Future.successful(null);
  }
}

/* istanbul ignore next */
class StderrLogger implements IMessageLogger {
  private level: string;
  constructor(level: string) {
    this.level = level;
  }

  log(message: string, args: any[]): Future<void> {
    const formattedMessage = util.format(message, ...args);
    console.error('%s: %s', this.level, formattedMessage);
    return Future.successful(null);
  }
}

class MongodbLogger implements IMessageLogger {
  private level: string;
  private collectionName: string;
  constructor(level: string, collectionName: string) {
    if (collectionName === '') {
      throw new Error('Cannot set logger: collection cannot be an empty string');
    }

    this.level = level;
    this.collectionName = collectionName;
  }

  log(message: string, args: any[]): Future<void> {
    let formattedMessage = util.format(message, ...args);
    let logDocument = {
      level: this.level,
      message: formattedMessage,
      date: new Date()
    };

    let collection = db.connection().collection(this.collectionName);
    return Future.denodify<void>(collection.insert, collection, logDocument);
  }
}

class FluentdLogger implements IMessageLogger {
  private level: string;
  private host: string;
  private port: string;
  private logger: fluentd.Logger;

  constructor(level: string, host: string, port: string) {
    this.level = level;
    this.host = host;
    this.port = port;

    this.logger = fluentd.createFluentSender('beyond.ts', {host, port});
    this.logger.on('error', (err: any) => {
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        // just ignore connection problem
        return;
      }

      throw err;
    });
  }

  log(message: string, args: any[]): Future<void> {
    let formattedMessage = util.format(message, ...args);
    return Future.denodify<void>(this.logger.emit, this.logger, this.level, formattedMessage);
  }
}

function getLoggerByMethod(method: string, level: string): IMessageLogger {
  /* istanbul ignore next */
  if (method === 'stdout') {
    return new StdoutLogger(level);
  }

  /* istanbul ignore next */
  if (method === 'stderr') {
    return new StderrLogger(level);
  }

  const mongodbPrefix = 'mongodb:';
  const mongodbPrefixLength = mongodbPrefix.length;

  if (method.substring(0, mongodbPrefixLength) === mongodbPrefix) {
    let collectionName = method.substring(mongodbPrefixLength);
    return new MongodbLogger(level, collectionName);
  }

  const fluentdPrefix = 'fluentd:';
  const fluentdPrefixLength = fluentdPrefix.length;

  if (method.substring(0, fluentdPrefixLength) === fluentdPrefix) {
    let hostAndPort = method.substring(fluentdPrefixLength).split(':');
    return new FluentdLogger(level, hostAndPort[0], hostAndPort[1]);
  }

  throw new Error(util.format('Cannot set logger: %j is not valid option for %j', method, level));
}

export function create(config: { [level: string]: any }): (level: string, message: string, args?: any[]) => Future<void> {
  let logger: { [level: string]: IMessageLogger[] } = { };

  _.map(config, (config: any, level: string) => {
    if (!config) {
      return;
    }

    if (_.isString(config)) {
      logger[level] = [ getLoggerByMethod(config, level) ];
      return;
    }


    if (_.isArray(config)) {
      logger[level] = config.map((method: string): IMessageLogger => {
        return getLoggerByMethod(method, level);
      });
      return;
    }

    throw new Error(util.format('Cannot set logger: %j is not valid option for %j', config, level));
  });

  return (level: string, message: string, args: any[] = []): Future<void> => {
    if (!logger[level]) {
      return Future.successful(null);
    }

    let loggers = logger[level];
    let logging = loggers.map((logger: IMessageLogger): Future<void> => {
      return logger.log(message, args);
    });

    return <any>Future.sequence(logging);
  };
}
