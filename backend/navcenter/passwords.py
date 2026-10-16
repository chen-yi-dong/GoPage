"""密码单向加密

只存摘要、不存明文；校验使用恒定时间比较，防止时序攻击。
独立成模块是因为它是最「纯粹」的函数：不依赖项目里任何其他东西。
"""
import hashlib
import secrets

from .paths import PBKDF2_ITERATIONS


def hash_password(password, salt=None):
    """使用 PBKDF2-HMAC-SHA256 生成密码摘要；salt 为空时随机生成"""
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        PBKDF2_ITERATIONS
    )
    return {
        'salt': salt,
        'hash': digest.hex(),
        'algo': 'pbkdf2_sha256',
        'iterations': PBKDF2_ITERATIONS,
    }


def verify_password(password, record):
    """校验密码，使用恒定时间比较防止时序攻击"""
    if not isinstance(record, dict):
        return False
    expected = record.get('hash') or ''
    calculated = hash_password(password, record.get('salt') or '')['hash']
    return secrets.compare_digest(calculated, expected)
