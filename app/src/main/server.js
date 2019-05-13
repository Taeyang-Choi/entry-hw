'use strict';
const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events').EventEmitter;
const client = require('socket.io-client');
const { SERVER_MODE_TYPES } = require('../common/constants');
const rendererConsole = require('./utils/rendererConsole');
const NetworkZipHandlerStream = require('./utils/networkZipHandleStream');

/**
 * 하드웨어 <-> 엔트리 워크스페이스 통신간 사용되는 클래스.
 * http[s] 서버와 socketIO 서버를 오픈한다.
 * 클라우드 모드에서 서버가 EADDRINUSE 로 실패한 경우, 클라이언트 모드로 동작한다.
 * 클라이언트 모드에서는 서버 PC 를 호스트로 엔트리와 통신한다.
 *
 * EventEmitter 는 외부로 아래와 같은 이벤트를 발생시킨다
 * - connection : 웹소켓 서버가 엔트리와 연결된 경우
 * - close : 소켓서버가 닫힘
 * - closed : 소켓, httpServer 전체가 닫힘
 * - data : 서버에서 받은 데이터. 인자는 data, type 를 발생시킨다.
 */
class Server extends EventEmitter {
    constructor(router) {
        super();
        this.router = router;
        this.packet = new Buffer([0x01, 0x00, 0x00, 0x00]);
        this.connections = [];
        this.connectionSet = {};
        this.roomCnt = 0;
        this.childServerList = {};
        this.clientTargetList = {};
        this.runningMode = SERVER_MODE_TYPES.parent;
        this.currentServerMode = SERVER_MODE_TYPES.single;
        this.masterRoomIds = [];
        this.clientRoomId = '';
        this.socketClient = undefined; // 클라이언트인 경우 세팅됨
        this.socketServer = undefined; // 호스트인 경우 세팅됨
    }

    addRoomIdsOnSecondInstance(roomId) {
        if (this.runningMode === SERVER_MODE_TYPES.parent) {
            if (this.masterRoomIds.indexOf(roomId) === -1) {
                this.masterRoomIds.push(roomId);
            }
        } else {
            if (roomId) {
                this.clientRoomId = roomId;
                this.socketClient && this.socketClient.emit('matchTarget', { roomId });
                if (this.masterRoomIds.indexOf(roomId) === -1) {
                    this.masterRoomIds.push(roomId);
                }
            }
        }
    }

    /**
     * 연결된 클라우드 PC 여부에 따라
     * single, multi 모드 전환한다.
     * 렌더러에 이미지를 표기하기 위해 사용된다.
     * currentServerMode 는 여기서 세팅만 되며,
     * 최초 구동시 메인 프로세스보다 느리게 세팅되는 렌더러 쪽에서 현재 서버모드를
     * 체크할때 가져간다.
     * @param mode
     */
    toggleServerMode(mode) {
        this.currentServerMode = mode;
        this.router.notifyServerMode(mode);
    }

    open() {
        const PORT = 23518;
        const { httpServer, address } = this._getHttpServer(PORT);

        /*
         * 에러가 발생하는 경우는 EADDRINUSE 로 상정한다.
         * 동일 IP + 클라우드 PC 환경이라고 가정하고,
         * 클라우드 내 최초 실행된 PC 가 서버, 그 뒤에 실행된 PC 에서는
         * EADDRINUSE 가 발생.
         * 그런 경우 직접 로컬호스트발 소켓 클라이언트를 연다.
         */
        httpServer.on('error', (e) => {
            this.runningMode = SERVER_MODE_TYPES.child;
            this.toggleServerMode(SERVER_MODE_TYPES.multi);

            const socket = this._createSocketClient(address);
            this.connections.push(socket);
            this.socketClient = socket;
        });

        /*
         * 서버가 정상오픈된 경우. 서버로 동작한다.
         * 일반 모드인 경우는 상관없다.
         * 클라우드 모드인 경우, 클라이언트들의 데이터까지 처리하는 부하문제가 있다.
         * 정상 오픈이 된 경우 socketIO 서버를 오픈한다.
         */
        httpServer.on('listening', (e) => {
            const mRoomIds = this.router.roomIds;
            if (mRoomIds.length > 0) {
                mRoomIds.forEach((mRoomId) => {
                    if (this.masterRoomIds.indexOf(mRoomId) === -1 && mRoomId) {
                        this.masterRoomIds.push(mRoomId);
                    }
                });
            }
            this.runningMode = SERVER_MODE_TYPES.parent;
            this.httpServer = httpServer;

            this.socketServer = this._createSocketServer(httpServer);
        });

        httpServer.listen(PORT);
    };

    /**
     * httpServer 오픈에 실패하여 (클라우드 등) 직접 socketIO 클라이언트를 만든다.
     * @param address
     * @return {SocketIOClientStatic.Socket}
     * @private
     */
    _createSocketClient(address) {
        const socket = client(address, {
            query: { childServer: true },
            reconnectionAttempts: 3,
        });

        socket.on('connect', () => {
            const roomIds = this.router.roomIds;
            if (roomIds.length > 0) {
                roomIds.forEach((roomId) => {
                    if (roomId) {
                        if (this.masterRoomIds.indexOf(roomId) === -1) {
                            this.masterRoomIds.push(roomId);
                        }
                        socket.emit('matchTarget', { roomId });
                    }
                });
            }
        });

        socket.on('message', this.router.handleServerData);

        socket.on('mode', (data) => {
            socket.mode = data;
        });

        socket.on('reconnect_failed', () => {
            socket.close();
            this.toggleServerMode(SERVER_MODE_TYPES.single);
            this.socketClient = null;
            this.open();
        });

        socket.on('disconnect', () => {
            socket.close();
            this.socketClient = null;
            this.open();
        });

        return socket;
    }

    /**
     * httpServer 오픈에 성공한 뒤, SocketIO 서버를 오픈한다.
     *
     * @param httpServer{Server}
     * @return {SocketIO.Server}
     * @private
     */
    _createSocketServer(httpServer) {
        const server = require('socket.io')(httpServer);
        server.set('transports', [
            'websocket',
            'flashsocket',
            'htmlfile',
            'xhr-polling',
            'jsonp-polling',
            'polling',
        ]);

        server.on('connection', (socket) => {
            const connection = socket;
            this.connectionSet[connection.id] = connection;
            this.connections.push(connection);
            this.emit('connection');

            rendererConsole.info('Entry connected.');

            const roomId = connection.handshake.query.roomId;
            if (connection.handshake.query.childServer === 'true') {
                this.childServerList[connection.id] = true;
            } else {
                connection.join(roomId);
                connection.roomId = roomId;
            }

            const childServerListCnt = Object.keys(this.childServerList).length;
            if (childServerListCnt > 0) {
                server.emit('mode', SERVER_MODE_TYPES.multi);
                this.toggleServerMode(SERVER_MODE_TYPES.multi);
            } else {
                server.emit('mode', SERVER_MODE_TYPES.single);
                this.toggleServerMode(SERVER_MODE_TYPES.single);
            }

            connection.on('matchTarget', (data) => {
                if (
                    connection.handshake.query.childServer === 'true' &&
                    data.roomId
                ) {
                    if (!connection.roomIds) {
                        connection.roomIds = [];
                    }

                    if (connection.roomIds.indexOf(data.roomId) === -1) {
                        connection.roomIds.push(data.roomId);
                    }

                    this.clientTargetList[data.roomId] = connection.id;
                    server.to(data.roomId).emit('matched', connection.id);
                }
            });

            connection.on('disconnect', (socket) => {
                if (connection.handshake && connection.handshake.query.childServer === 'true') {
                    if (connection.roomIds && connection.roomIds.length > 0) {
                        connection.roomIds.forEach((roomId) => {
                            server.to(roomId).emit('matching');
                        });
                    }
                    delete this.connectionSet[connection.id];
                    delete this.childServerList[connection.id];

                    const childServerListCnt = Object.keys(this.childServerList).length;
                    if (childServerListCnt <= 0) {
                        server.emit('mode', SERVER_MODE_TYPES.single);
                        this.toggleServerMode(SERVER_MODE_TYPES.single);
                    }
                } else {
                    delete this.connectionSet[connection.id];
                }
            });

            connection.on('message', (message, ack) => {
                console.log('socketServer receive : ', message);
                if (message.action === 'init') {
                    const { name } = JSON.parse(message.data);
                    this._requestHardware(name);
                }

                if (
                    message.mode === SERVER_MODE_TYPES.single ||
                    this.masterRoomIds.indexOf(connection.roomId) >= 0
                ) {
                    this.router.handleServerData(message);
                } else {
                    if (connection.handshake.query.childServer === 'true') {
                        if (
                            connection.roomIds &&
                            connection.roomIds.length > 0
                        ) {
                            connection.roomIds.forEach((roomId) => {
                                server.to(roomId).emit('message', message);
                            });
                        }
                    } else if (this.clientTargetList[connection.roomId]) {
                        server.to(this.clientTargetList[connection.roomId]).emit('message', message);
                    }
                }
                if (ack) {
                    const { key = true } = message;
                    ack(key);
                }
            });

            connection.on('close', (reasonCode, description) => {
                rendererConsole.warn('Entry disconnected.');
                this.emit('close');
                this.closeSingleConnection(this);
            });
            this.setState(this.state);
        });
        return server;
    }

    /**
     * SSL 인증서가 프로젝트에 포함되어있는 경우는 https,
     * 그렇지 않은 경우는 http 서버를 오픈한다.
     *
     * @param port{number} 오픈할 포트번호
     * @return {{address: string, httpServer: Server}}
     * @private
     */
    _getHttpServer(port) {
        let httpServer;
        let address;

        const rootDir = path.resolve(__dirname, '..', '..');
        if (fs.existsSync(path.resolve(rootDir, 'ssl', 'cert.pem'))) {
            httpServer = require('https').createServer({
                key: fs.readFileSync(path.resolve(rootDir, 'ssl', 'hardware.key')),
                cert: fs.readFileSync(path.resolve(rootDir, 'ssl', 'cert.pem')),
                ca: [
                    fs.readFileSync(path.resolve(rootDir, 'ssl', 'ChainCA1.crt')),
                    fs.readFileSync(path.resolve(rootDir, 'ssl', 'ChainCA2.crt')),
                    fs.readFileSync(path.resolve(rootDir, 'ssl', 'RootCA.crt')),
                ],
            });
            address = `https://hardware.playentry.org:${port}`;
        } else {
            httpServer = require('http').createServer();
            address = `http://127.0.0.1:${port}`;
        }

        return {
            httpServer,
            address,
        };
    }

    _requestHardware(moduleName) {
        return new Promise((resolve, reject) => {
            if (!moduleName) {
                reject();
                return;
            }

            console.log(`/api/hardware/${moduleName}/module`);
            const { host, protocol } = global.sharedObject;
            //TODO 개발간 임시
            const request = net.request({
                host: 'localhost:4000',
                protocol: 'http:',
                path: `/api/hardware/${moduleName}/module`,
            });
            request.on('response', (response) => {
                // TODO 수신완료시점을 200으로? 모듈로드 완료시점을 200으로?
                response.on('error', reject);
                if (response.statusCode === 200) {
                    const moduleDirPath = path.resolve('app', 'modules');
                    const zipStream = new NetworkZipHandlerStream(moduleDirPath);
                    zipStream.on('done', () => {
                        console.log('donedone');
                        fs.readFile(
                            path.join(moduleDirPath, `${moduleName}.json`),
                            (err, data) => {
                                const config = JSON.parse(data);
                                this.router.sendState('show_robot', config);
                                this.router.startScan(config);
                            });
                        resolve();
                    });

                    response.pipe(zipStream);
                    response.on('end', () => {
                        // nothing to do
                    });
                } else {
                    reject();
                }
            });
            request.end();
        });
    }

    closeSingleConnection(connection) {
        const connections = this.connections;
        const index = connections.indexOf(connection);
        if (index > -1) {
            this.connections.slice(index, 1);
            connection.close();
        }
    };

    /**
     *
     * @param payload {Object} {action:String, data:Object}
     */
    send(payload) {
        const childServerListCnt = Object.keys(this.childServerList).length;
        if (
            (this.runningMode === SERVER_MODE_TYPES.parent && childServerListCnt === 0) ||
            this.runningMode === SERVER_MODE_TYPES.child
        ) {
            if (this.connections.length !== 0) {
                this.connections.map((connection) => {
                    connection.emit('message', payload);
                });
            }
        } else if (this.masterRoomIds.length > 0) {
            this.masterRoomIds.forEach((masterRoomId) => {
                this.socketServer.to(masterRoomId).emit('message', payload);
            });
        }
    };

    setState(state) {
        this.state = state;
        if (this.connections.length) {
            const packet = this.packet;
            if (state === 'connecting') {
                packet[3] = 0x01;
                this.send({ data: packet });
            } else if (state === 'connected') {
                packet[3] = 0x02;
                this.send({ data: packet });
            } else if (state === 'lost') {
                packet[3] = 0x03;
                this.send({ data: packet });
            } else if (state === 'disconnected') {
                packet[3] = 0x04;
                this.send({ data: packet });
            }
        }
    };

    disconnectHardware() {
        this.send({
            action: 'state',
            data: {
                statement: 'disconnectHardware',
            },
        });
    };

    close() {
        if (this.socketServer) {
            this.socketServer.close();
            this.socketServer = undefined;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = undefined;
        }
        this.connections = [];
        this.emit('closed');
    };
}

module.exports = Server;
