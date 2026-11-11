"""JSON 文件存取

所有持久化读写都经过这里：
  * read_json  —— 读失败时返回默认值，不让异常冒泡到接口层
  * write_json —— 先写临时文件再原子替换，避免写入中断导致数据损坏
"""
import json
import os
import threading
import uuid

# 单进程部署（gunicorn --workers 1 --threads 8）下所有请求线程共享的锁。
# 由 create_app() 在每个 /api 请求开始时获取，保证「读-改-写」整体原子。
DATA_LOCK = threading.RLock()


def read_json(path, default=None):
    """读取 JSON 文件；文件不存在或内容损坏时返回 default"""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    """先写临时文件再原子替换，避免写入中断导致数据损坏"""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    # 临时文件名带随机后缀：避免并发写同一个 tmp 时内容互相覆盖，
    # 或 os.replace 因 tmp 已被别的线程移走而抛 FileNotFoundError
    tmp_file = f'{path}.{uuid.uuid4().hex}.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    os.replace(tmp_file, path)


def no_cache(resp):
    """给响应加上「不缓存」头（配置 / 设置类接口必须实时生效）"""
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp
