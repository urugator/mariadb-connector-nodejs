'use strict';

const base = require('../base.js');
const { assert } = require('chai');
const Conf = require('../conf');

describe('authentication plugin', () => {
  let rsaPublicKey = process.env.TEST_RSA_PUBLIC_KEY;
  let cachingRsaPublicKey = process.env.TEST_CACHING_RSA_PUBLIC_KEY;

  before(async function () {
    if (!rsaPublicKey) {
      if (!shareConn.info.isMariaDB() && shareConn.info.hasMinVersion(5, 7, 0)) {
        const res = await shareConn.query({
          sql: "SHOW STATUS LIKE 'Rsa_public_key'",
          rowsAsArray: true
        });
        rsaPublicKey = res[0][1];
      }
    }

    if (!cachingRsaPublicKey) {
      if (!shareConn.info.isMariaDB() && shareConn.info.hasMinVersion(8, 0, 0)) {
        const res = await shareConn.query({
          sql: "SHOW STATUS LIKE 'Caching_sha2_password_rsa_public_key'",
          rowsAsArray: true
        });
        cachingRsaPublicKey = res[0][1];
      }
    }

    await shareConn.query("DROP USER IF EXISTS 'sha256User'@'%'");
    await shareConn.query("DROP USER IF EXISTS 'cachingSha256User'@'%'");
    await shareConn.query("DROP USER IF EXISTS 'cachingSha256User2'@'%'");
    await shareConn.query("DROP USER IF EXISTS 'cachingSha256User3'@'%'");

    if (!shareConn.info.isMariaDB()) {
      if (shareConn.info.hasMinVersion(8, 0, 0)) {
        await shareConn.query("CREATE USER 'sha256User'@'%' IDENTIFIED WITH sha256_password BY 'password'");
        await shareConn.query("GRANT ALL PRIVILEGES ON *.* TO 'sha256User'@'%'");

        await shareConn.query(
          "CREATE USER 'cachingSha256User'@'%' IDENTIFIED WITH caching_sha2_password BY 'password'"
        );
        await shareConn.query("GRANT ALL PRIVILEGES ON *.* TO 'cachingSha256User'@'%'");
        await shareConn.query(
          "CREATE USER 'cachingSha256User2'@'%' IDENTIFIED WITH caching_sha2_password BY 'password'"
        );
        await shareConn.query("GRANT ALL PRIVILEGES ON *.* TO 'cachingSha256User2'@'%'");
        await shareConn.query(
          "CREATE USER 'cachingSha256User3'@'%'  IDENTIFIED WITH caching_sha2_password BY 'password'"
        );
        await shareConn.query("GRANT ALL PRIVILEGES ON *.* TO 'cachingSha256User3'@'%'");
      } else {
        await shareConn.query("CREATE USER 'sha256User'@'%'");
        await shareConn.query(
          "GRANT ALL PRIVILEGES ON *.* TO 'sha256User'@'%' IDENTIFIED WITH " + "sha256_password BY 'password'"
        );
      }
    }
  });

  it('ed25519 authentication plugin', async function () {
    if (process.env.srv === 'maxscale' || process.env.srv === 'skysql-ha') this.skip();
    const self = this;
    if (!shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(10, 1, 22)) this.skip();

    const res = await shareConn.query('SELECT @@strict_password_validation as a');
    if (res[0].a === 1 && !shareConn.info.hasMinVersion(10, 4, 0)) self.skip();
    await shareConn.query("INSTALL SONAME 'auth_ed25519'");
    await shareConn.query("drop user IF EXISTS verificationEd25519AuthPlugin@'%'");
    if (shareConn.info.hasMinVersion(10, 4, 0)) {
      await shareConn.query(
        "CREATE USER verificationEd25519AuthPlugin@'%' IDENTIFIED " + "VIA ed25519 USING PASSWORD('MySup8%rPassw@ord')"
      );
    } else {
      await shareConn.query(
        "CREATE USER verificationEd25519AuthPlugin@'%' IDENTIFIED " +
          "VIA ed25519 USING '6aW9C7ENlasUfymtfMvMZZtnkCVlcb1ssxOLJ0kj/AA'"
      );
    }

    await shareConn.query('GRANT SELECT on  `' + Conf.baseConfig.database + "`.* to verificationEd25519AuthPlugin@'%'");
    try {
      let conn = await base.createConnection({
        user: 'verificationEd25519AuthPlugin',
        password: 'MySup8%rPassw@ord'
      });
      conn.end();
      try {
        conn = await base.createConnection({
          user: 'verificationEd25519AuthPlugin',
          password: 'MySup8%rPassw@ord',
          restrictedAuth: ''
        });
        conn.end();
        throw new Error('must have thrown error');
      } catch (err) {
        assert.equal(err.text, 'Unsupported authentication plugin client_ed25519. Authorized plugin: ');
        assert.equal(err.errno, 45047);
        assert.equal(err.sqlState, '42000');
        assert.equal(err.code, 'ER_NOT_SUPPORTED_AUTH_PLUGIN');
        assert.isTrue(err.fatal);
      }
    } catch (err) {
      const expectedMsg = err.message.includes(
        "Client does not support authentication protocol 'client_ed25519' requested by server."
      );
      if (!expectedMsg) console.log(err);
      assert(expectedMsg);
    }
  });

  it('name pipe authentication plugin', function (done) {
    if (process.platform !== 'win32') this.skip();
    if (process.env.srv === 'maxscale') this.skip();
    if (!shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(10, 1, 11)) this.skip();
    if (Conf.baseConfig.host !== 'localhost' && Conf.baseConfig.host !== 'mariadb.example.com') this.skip();
    const windowsUser = process.env.USERNAME;
    if (windowsUser === 'root') this.skip();

    const self = this;
    shareConn
      .query('SELECT @@named_pipe as pipe')
      .then((res) => {
        if (res[0].pipe) {
          shareConn
            .query("INSTALL PLUGIN named_pipe SONAME 'auth_named_pipe'")
            .then(() => {})
            .catch((err) => {});
          shareConn
            .query('DROP USER ' + windowsUser)
            .then(() => {})
            .catch((err) => {});
          shareConn
            .query('CREATE USER ' + windowsUser + " IDENTIFIED VIA named_pipe using 'test'")
            .then(() => {
              return shareConn.query('GRANT SELECT on *.* to ' + windowsUser);
            })
            .then(() => {
              return shareConn.query('select @@version_compile_os,@@socket soc');
            })
            .then((res) => {
              return base.createConnection({
                user: null,
                socketPath: '\\\\.\\pipe\\' + res[0].soc
              });
            })
            .then((conn) => {
              return conn.end();
            })
            .then(done)
            .catch(done);
        } else {
          console.log('named pipe not enabled');
          self.skip();
        }
      })
      .catch((err) => {});
  });

  it('unix socket authentication plugin', function (done) {
    if (process.platform === 'win32') this.skip();
    if (!shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(10, 1, 11)) this.skip();
    if (!process.env.LOCAL_SOCKET_AVAILABLE) this.skip();
    if (Conf.baseConfig.host !== 'localhost' && Conf.baseConfig.host !== 'mariadb.example.com') this.skip();

    shareConn
      .query('select @@version_compile_os,@@socket soc')
      .then((res) => {
        const unixUser = process.env.USER;
        if (!unixUser || unixUser === 'root') this.skip();
        console.log('unixUser:' + unixUser);
        shareConn.query("INSTALL PLUGIN unix_socket SONAME 'auth_socket'").catch((err) => {});
        shareConn.query('DROP USER IF EXISTS ' + unixUser);
        shareConn
          .query("CREATE USER '" + unixUser + "'@'" + Conf.baseConfig.host + "' IDENTIFIED VIA unix_socket")
          .catch((err) => {});
        shareConn
          .query("GRANT SELECT on *.* to '" + unixUser + "'@'" + Conf.baseConfig.host + "'")
          .then(() => {
            base
              .createConnection({ user: null, socketPath: res[0].soc })
              .then((conn) => {
                return conn.end();
              })
              .then(() => {
                done();
              })
              .catch(done);
          })
          .catch(done);
      })
      .catch(done);
  });

  it('dialog authentication plugin', async function () {
    //pam is set using .travis/sql/pam.sh
    if (!process.env.TEST_PAM_USER) this.skip();

    if (!shareConn.info.isMariaDB()) this.skip();
    this.timeout(10000);
    try {
      await shareConn.query("INSTALL PLUGIN pam SONAME 'auth_pam'");
    } catch (error) {}
    try {
      await shareConn.query("DROP USER IF EXISTS '" + process.env.TEST_PAM_USER + "'@'%'");
    } catch (error) {}

    await shareConn.query("CREATE USER '" + process.env.TEST_PAM_USER + "'@'%' IDENTIFIED VIA pam USING 'mariadb'");
    await shareConn.query("GRANT SELECT ON *.* TO '" + process.env.TEST_PAM_USER + "'@'%' IDENTIFIED VIA pam");
    await shareConn.query('FLUSH PRIVILEGES');

    let testPort = Conf.baseConfig.port;
    if (process.env.TEST_PAM_PORT != null) {
      testPort = parseInt(process.env.TEST_PAM_PORT);
    }
    //password is unix password "myPwd"
    try {
      const conn = await base.createConnection({
        user: process.env.TEST_PAM_USER,
        password: process.env.TEST_PAM_PWD,
        port: testPort
      });
      await conn.end();
    } catch (err) {
      if (err.errno !== 1045 && err.errno !== 1044) {
        throw err;
      }
    }
  });

  it('dialog authentication plugin multiple password', async function () {
    //pam is set using .travis/sql/pam.sh
    if (!process.env.TEST_PAM_USER) this.skip();

    if (!shareConn.info.isMariaDB()) this.skip();
    this.timeout(10000);
    try {
      await shareConn.query("INSTALL PLUGIN pam SONAME 'auth_pam'");
    } catch (error) {}
    try {
      await shareConn.query("DROP USER IF EXISTS '" + process.env.TEST_PAM_USER + "'@'%'");
    } catch (error) {}
    await shareConn.query("CREATE USER '" + process.env.TEST_PAM_USER + "'@'%' IDENTIFIED VIA pam USING 'mariadb'");
    await shareConn.query("GRANT SELECT ON *.* TO '" + process.env.TEST_PAM_USER + "'@'%' IDENTIFIED VIA pam");
    await shareConn.query('FLUSH PRIVILEGES');

    let testPort = Conf.baseConfig.port;
    if (process.env.TEST_PAM_PORT != null) {
      testPort = parseInt(process.env.TEST_PAM_PORT);
    }
    //password is unix password "myPwd"
    try {
      const conn = await base.createConnection({
        user: process.env.TEST_PAM_USER,
        password: [process.env.TEST_PAM_PWD, process.env.TEST_PAM_PWD],
        port: testPort
      });
      await conn.end();
    } catch (err) {
      if (err.errno !== 1045 && err.errno !== 1044) {
        throw err;
      }
    }
  });

  it('multi authentication plugin', function (done) {
    if (process.env.srv === 'maxscale' || process.env.srv === 'skysql' || process.env.srv === 'skysql-ha') this.skip();
    if (!shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(10, 4, 3)) this.skip();
    shareConn.query("drop user IF EXISTS mysqltest1@'%'").catch((err) => {});
    shareConn
      .query(
        "CREATE USER mysqltest1@'%' IDENTIFIED " +
          "VIA ed25519 as password('!Passw0rd3') " +
          " OR mysql_native_password as password('!Passw0rd3Works')"
      )
      .then(() => {
        return shareConn.query('grant SELECT on `' + Conf.baseConfig.database + "`.*  to mysqltest1@'%'");
      })
      .then(() => {
        return base.createConnection({
          user: 'mysqltest1',
          password: '!Passw0rd3'
        });
      })
      .then((conn) => {
        return conn.query("select '1'").then((res) => {
          return conn.end();
        });
      })
      .then(() => {
        base
          .createConnection({
            user: 'mysqltest1',
            password: '!Passw0rd3Works'
          })
          .then((conn) => {
            conn
              .query('select 1')
              .then((res) => {
                conn.end();
                base
                  .createConnection({
                    user: 'mysqltest1',
                    password: '!Passw0rd3Wrong'
                  })
                  .then((conn) => {
                    done(new Error('must have throw Error!'));
                  })
                  .catch(() => {
                    done();
                  });
              })
              .catch(done);
          })
          .catch(done);
      })
      .catch(done);
  });

  it('sha256 authentication plugin', function (done) {
    if (process.platform === 'win32') this.skip();
    if (!rsaPublicKey || shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(5, 7, 0)) this.skip();

    const self = this;
    base
      .createConnection({
        user: 'sha256User',
        password: 'password',
        rsaPublicKey: rsaPublicKey
      })
      .then((conn) => {
        conn.end();
        done();
      })
      .catch((err) => {
        if (err.message.includes('sha256_password authentication plugin require node 11.6+')) self.skip();
        done(err);
      });
  });

  it('sha256 authentication plugin with public key retrieval', function (done) {
    if (process.platform === 'win32') this.skip();
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(5, 7, 0)) this.skip();

    const self = this;
    base
      .createConnection({
        user: 'sha256User',
        password: 'password',
        allowPublicKeyRetrieval: true
      })
      .then((conn) => {
        conn.end();
        done();
      })
      .catch((err) => {
        if (err.message.includes('sha256_password authentication plugin require node 11.6+')) self.skip();
        done(err);
      });
  });

  it('sha256 authentication plugin without public key retrieval', function (done) {
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(5, 7, 0)) this.skip();

    base
      .createConnection({
        user: 'sha256User',
        password: 'password'
      })
      .then((conn) => {
        conn.end();
        done(new Error('must have thrown error'));
      })
      .catch((err) => {
        assert.isTrue(
          err.message.includes('RSA public key is not available client side.') ||
            err.message.includes('sha256_password authentication plugin require node 11.6+')
        );
        done();
      });
  });

  it('sha256 authentication plugin with ssl', function (done) {
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(5, 7, 0)) this.skip();

    const self = this;
    shareConn
      .query("SHOW VARIABLES LIKE 'have_ssl'")
      .then((rows) => {
        // console.log("ssl is not enable on database, skipping test :");
        if (rows[0].Value === 'YES') {
          base
            .createConnection({
              user: 'sha256User',
              password: 'password',
              ssl: {
                rejectUnauthorized: false
              }
            })
            .then((conn) => {
              conn.end();
              done();
            })
            .catch((err) => {
              if (err.message.includes('sha256_password authentication plugin require node 11.6+')) self.skip();
              done(err);
            });
        } else {
          this.skip();
        }
      })
      .catch(done);
  });

  it('cachingsha256 authentication plugin', function (done) {
    if (process.platform === 'win32') this.skip();
    if (!rsaPublicKey || shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(8, 0, 0)) this.skip();

    const self = this;
    base
      .createConnection({
        user: 'cachingSha256User',
        password: 'password',
        cachingRsaPublicKey: rsaPublicKey
      })
      .then((conn) => {
        conn.end();
        //using fast auth
        base
          .createConnection({
            user: 'cachingSha256User',
            password: 'password',
            cachingRsaPublicKey: rsaPublicKey
          })
          .then((conn) => {
            conn.end();
            done();
          })
          .catch(done);
      })
      .catch((err) => {
        if (err.message.includes('caching_sha2_password authentication plugin require node 11.6+')) self.skip();
        done(err);
      });
  });

  it('cachingsha256 authentication plugin with public key retrieval', function (done) {
    if (process.platform === 'win32') this.skip();
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(8, 0, 0)) this.skip();

    const self = this;
    base
      .createConnection({
        user: 'cachingSha256User2',
        password: 'password',
        allowPublicKeyRetrieval: true
      })
      .then((conn) => {
        conn.end();
        done();
      })
      .catch((err) => {
        if (err.message.includes('caching_sha2_password authentication plugin require node 11.6+')) self.skip();
        done(err);
      });
  });

  it('cachingsha256 authentication plugin without public key retrieval', function (done) {
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(8, 0, 0)) this.skip();

    base
      .createConnection({
        user: 'cachingSha256User3',
        password: 'password'
      })
      .then((conn) => {
        conn.end();
        done(new Error('must have thrown error'));
      })
      .catch((err) => {
        assert.isTrue(
          err.message.includes('RSA public key is not available client side.') ||
            err.message.includes('caching_sha2_password authentication plugin require node 11.6+')
        );
        done();
      });
  });

  it('cachingsha256 authentication plugin with ssl', function (done) {
    if (shareConn.info.isMariaDB() || !shareConn.info.hasMinVersion(8, 0, 0)) this.skip();

    const self = this;
    shareConn
      .query("SHOW VARIABLES LIKE 'have_ssl'")
      .then((rows) => {
        // console.log("ssl is not enable on database, skipping test :");
        if (rows[0].Value === 'YES') {
          base
            .createConnection({
              user: 'cachingSha256User3',
              password: 'password',
              ssl: {
                rejectUnauthorized: false
              }
            })
            .then((conn) => {
              conn.end();
              done();
            })
            .catch((err) => {
              if (err.message.includes('caching_sha2_password authentication plugin require node 11.6+')) self.skip();
              done();
            });
        } else {
          self.skip();
        }
      })
      .catch(done);
  });
});
