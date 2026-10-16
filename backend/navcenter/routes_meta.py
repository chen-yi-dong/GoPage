"""元信息接口：GET /api/meta

前端启动时用它确认「页面连的是不是本后端服务」。
"""
from flask import Blueprint, jsonify

from .paths import APP_NAME, APP_RELEASE_DATE, APP_VERSION
from .storage import no_cache

bp = Blueprint('meta', __name__, url_prefix='/api')


@bp.route('/meta', methods=['GET'])
def get_meta():
    return no_cache(jsonify({
        'name': APP_NAME,
        'version': APP_VERSION,
        'release_date': APP_RELEASE_DATE,
    }))
