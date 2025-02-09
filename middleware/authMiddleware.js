import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { QueryTypes } from 'sequelize';
import sequelizeConfig from '../src/config/sequelize.js';
import UserEndpointAccessLogModel from '../src/models/userEndpointAccessLog.js';
import routesPermissions from '../src/routes/routesPermissions.js';
import services from '../src/services/_index.js';

const publicEndpoints = [
  { pattern: /^\/\?.*/, method: 'GET' }, // Route '/' is public
];

async function authenticate(req, res, next) {
  const isPublicEndpoint = publicEndpoints.some(
    endpoint =>
      endpoint.pattern.test(req.originalUrl) && endpoint.method === req.method,
  );
  let isAccepted = true;
  let message = null;

  if (isPublicEndpoint) {
    await registerEndpointLogEvent({ req, isAccepted, message });
    next();
    return;
  }

  const authorizationHeader = req.headers.authorization;

  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer')) {
    isAccepted = false;
    message = 'Nenhum token fornecido!';
  } else {
    try {
      const token = authorizationHeader.split(' ')[1];
      const decodedUser = jwt.verify(token, process.env.JWT_SECRET).id;

      const userData = await services.userService.findUserWithRole(
        decodedUser.cpf,
      );

      if (!userData || userData.accepted === false) {
        throw new Error('');
      }

      const hasActiveSession =
        await services.userAccessLogService.hasActiveSessionRelatedToJWT(token);
      if (!hasActiveSession) {
        throw new Error('Token não associado a uma sessão ativa.');
      }

      ({ isAccepted, message } = checkPermissions({
        req,
        isAccepted,
        message,
        userData,
      }));
    } catch (error) {
      isAccepted = false;
      message =
        error.name === 'TokenExpiredError'
          ? 'O token expirou!'
          : error.message || 'Autenticação falhou!';
    }
  }

  await registerEndpointLogEvent({ req, isAccepted, message });

  if (!isAccepted) {
    return res.status(401).json({ message });
  }

  next();
}

function getRequiredPermissions(req) {
  const requestPath = req.path;
  let matchingPermissions = null;
  let wasFound = false;
  for (let parentRoute of routesPermissions) {
    if (wasFound) break;
    for (const childRoute of parentRoute.childRoutes) {
      const fullPath =
        parentRoute.parentPath +
        (childRoute.path === '' ? '' : childRoute.path);
      const regexPath = fullPath.replace(/\/:[^\/]+/g, '/[^/]+');
      const regex = new RegExp(`^${regexPath}$`);
      if (regex.test(requestPath) && childRoute?.method === req.method) {
        matchingPermissions = childRoute.permissions;
        wasFound = true;
        break;
      }
    }
  }
  return matchingPermissions;
}

async function tokenToUser(req, res) {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET).id;

      const userData = await sequelizeConfig.query(
        `select * from users u where cpf = :cpf limit 1`,
        {
          type: QueryTypes.SELECT,
          replacements: { cpf: decoded.cpf },
          logging: false,
        },
      );

      if (userData[0].accepted === false) {
        throw new Error();
      }
      return userData[0];
    } catch (error) {
      return res.status(401);
    }
  }
}

function checkPermissions({ req, isAccepted, message, userData }) {
  let requiredPermissions = getRequiredPermissions(req);
  if (requiredPermissions) {
    requiredPermissions = Array.isArray(requiredPermissions)
      ? requiredPermissions
      : [requiredPermissions];
    if (
      !requiredPermissions.every(p => userData.role.allowedActions.includes(p))
    ) {
      isAccepted = false;
      message = 'Permissão negada!';
    }
  }
  return { isAccepted, message };
}

async function userFromReq(req) {
  const token = req.headers.authorization.split(' ')[1];
  return jwt.decode(token).id;
}

async function getUserRoleAndUnitFilterFromReq(req) {
  const userInfo = await userFromReq(req);
  const idRole = userInfo.role.idRole;
  const idUnit = userInfo.unit.idUnit;

  if (idRole === 5) return { idUnit };
  else return { idRole, idUnit };
}

async function registerEndpointLogEvent({ req, isAccepted, message }) {
  let userCPF;
  try {
    userCPF = (await userFromReq(req)).cpf;
  } catch (e) {
    userCPF = null;
  }
  try {
    await UserEndpointAccessLogModel.create({
      endpoint: req.originalUrl,
      httpVerb: req.method,
      attemptTimestamp: new Date(),
      userCPF,
      isAccepted,
      message,
      service: 'Unit',
    });
  } catch (error) {
    console.error('Error logging request: ', error);
  }
}

export {
  tokenToUser,
  authenticate,
  userFromReq,
  getUserRoleAndUnitFilterFromReq,
};
